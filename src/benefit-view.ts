// 设置页「福利码」区块：输入福利码兑换会员时长。
// 档位与时长全部由服务端下发，插件不内置业务常量；具体设置项是否展示由外层按活动开关决定。

import { Notice, Setting, type TextComponent } from "obsidian";

import { benefitCodeLength } from "./benefit-state";
import { debugLog } from "./debug-log";
import type PickpenPlugin from "./index";
import { ErrCode, errorCode } from "./remote-connect";

/** 赠送时长文案；月数与天数二选一，异常数据（都非正）时退化为「会员」。 */
export function benefitDurationText(months: bigint, days: bigint): string {
	if (months > 0n) return `${months.toString()} 个月`;
	if (days > 0n) return `${days.toString()} 天`;
	return "";
}

/** 档位展示名：服务端下发的是稳定标识（pro/max），展示时只把首字母大写。 */
export function benefitPlanText(planId: string): string {
	if (!planId) return "";
	return planId.charAt(0).toUpperCase() + planId.slice(1);
}

/** 到期时间只展示到日：会员到期按天理解即可。 */
export function formatBenefitDate(ms: bigint): string {
	if (ms <= 0n) return "";
	const date = new Date(Number(ms));
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 领取成功的提示文案。
 * 只陈述「获得了什么 + 会员有效期到哪天」，不写「已升级到 X 档」——
 * 订阅是排队顺延的，领高档次福利码不会立刻改变当前生效档位。
 */
export function benefitClaimText(planId: string, months: bigint, days: bigint, endsAtMs: bigint): string {
	const duration = benefitDurationText(months, days);
	const granted = [duration, benefitPlanText(planId)].filter(Boolean).join(" ");
	const until = formatBenefitDate(endsAtMs);

	if (!granted) {
		return "福利码领取成功";
	}
	return until ? `已获得 ${granted} 会员，有效期至 ${until}` : `已获得 ${granted} 会员`;
}

export function benefitErrorMessage(err: unknown): string {
	switch (errorCode(err)) {
		case ErrCode.BenefitCodeUnavailable:
			return "福利码无效或已下架，请检查后重试";
		case ErrCode.BenefitCodeExpired:
			return "该福利码不在活动期内";
		case ErrCode.BenefitAlreadyClaimed:
			return "该福利码你已领取过，同一福利码限领一次";
		case ErrCode.BenefitRequestInvalid:
			return "福利码格式不正确";
		case ErrCode.BenefitTooFrequent:
			return "尝试过于频繁，请稍后再试";
		case ErrCode.InvalidOrMissingCredentials:
			return "登录已失效，请重新登录";
		default:
			return "领取失败：网络不可达或服务端异常";
	}
}

/**
 * 渲染设置页的福利码区域，并返回异步回写的清理函数。
 * onClaimed 在领取成功后调用，由设置页刷新受影响的订阅分区。
 */
export function renderBenefitSection(containerEl: HTMLElement, plugin: PickpenPlugin, onClaimed: () => void): () => void {
	let disposed = false;
	const root = containerEl.createDiv({ cls: "pickpen-benefit" });

	if (!plugin.settings.accessToken) {
		new Setting(root).setName("登录后领取福利码").setDesc("请先在上方完成账号登录");
		return () => {
			disposed = true;
		};
	}

	const codeLength = benefitCodeLength();
	let code = "";
	let busy = false;
	let input: TextComponent | null = null;

	const setting = new Setting(root)
		.setName("福利码")
		.setDesc("输入福利码兑换会员时长；同一福利码每位用户限领一次");

	setting.addText((text) => {
		input = text;
		text.setPlaceholder(`${codeLength} 位数字`).onChange((value) => {
			code = value.replace(/\D/g, "").slice(0, codeLength);
			// 过滤后可能与输入不同（例如粘贴带空格），回写保证界面与提交值一致
			if (text.getValue() !== value) text.setValue(code);
		});
		text.inputEl.inputMode = "numeric";
		text.inputEl.maxLength = codeLength;
		text.inputEl.autocomplete = "off";
	});

	setting.addButton((button) =>
		button.setButtonText("领取").onClick(async () => {
			if (busy) return;
			if (!code) {
				setting.setErrorMessage("请输入福利码");
				return;
			}
			busy = true;
			setting.setErrorMessage(null);
			button.setDisabled(true).setButtonText("领取中…");
			try {
				const reply = await plugin.client.benefitClient.claimBenefitCode({ code });
				if (disposed) return;
				new Notice(benefitClaimText(reply.planId, reply.months, reply.days, reply.endsAtMs));
				code = "";
				input?.setValue("");
				onClaimed();
			} catch (err) {
				debugLog.error(`[pickpen] 福利码领取失败，错误码：${errorCode(err) ?? "unknown"}`);
				// 只走 Notice，不回写 setErrorMessage：后者是行下方常驻的红字，
				// 而这里的失败多为「已领取过」这类状态陈述，不该以报错形式留在表单里。
				new Notice(benefitErrorMessage(err));
			} finally {
				busy = false;
				button.setDisabled(false).setButtonText("领取");
			}
		}),
	);

	return () => {
		disposed = true;
	};
}

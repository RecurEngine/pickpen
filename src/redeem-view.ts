// 设置页「兑换码」区块：输入一次性兑换码兑换会员时长。
// 与福利码并列但语义不同：兑换码全局一次性，兑换成功会刷新订阅分区。

import { Notice, Setting, type TextComponent } from "obsidian";

import { benefitClaimText } from "./benefit-view";
import { debugLog } from "./debug-log";
import type PickpenPlugin from "./index";
import { isRedeemCodeCandidate, normalizeRedeemCodeInput, REDEEM_CODE_PLACEHOLDER, sanitizeRedeemCodeInput } from "./redeem-code";
import { ErrCode, errorCode } from "./remote-connect";

/** 兑换成功的提示文案；幂等回放不重复发放，文案必须如实说明。 */
export function redeemSuccessText(reply: {
	planId: string;
	months: bigint;
	endsAtMs: bigint;
	alreadyRedeemedByMe: boolean;
}): string {
	if (reply.alreadyRedeemedByMe) {
		return "该兑换码你已兑换过，本次未重复发放";
	}
	return benefitClaimText(reply.planId, reply.months, 0n, reply.endsAtMs);
}

export function redeemErrorMessage(err: unknown): string {
	switch (errorCode(err)) {
		case ErrCode.RedeemCodeUnavailable:
			return "兑换码无效或已作废，请检查后重试";
		case ErrCode.RedeemCodeUsed:
			return "该兑换码已被使用";
		case ErrCode.RedeemRequestInvalid:
			return "兑换码格式不正确";
		case ErrCode.RedeemTooFrequent:
			return "尝试过于频繁，请稍后再试";
		case ErrCode.InvalidOrMissingCredentials:
			return "登录已失效，请重新登录";
		default:
			return "兑换失败：网络不可达或服务端异常";
	}
}

/**
 * 渲染设置页的兑换码区域，并返回异步回写的清理函数。
 * onRedeemed 在兑换成功后调用，由设置页刷新受影响的订阅分区。
 */
export function renderRedeemSection(containerEl: HTMLElement, plugin: PickpenPlugin, onRedeemed: () => void): () => void {
	let disposed = false;
	const root = containerEl.createDiv({ cls: "pickpen-redeem" });

	if (!plugin.settings.accessToken) {
		new Setting(root).setName("登录后兑换").setDesc("请先在上方完成账号登录");
		return () => {
			disposed = true;
		};
	}

	let code = "";
	let busy = false;
	let input: TextComponent | null = null;

	const setting = new Setting(root)
		.setName("兑换码")
		.setDesc("输入兑换码兑换会员时长；每个兑换码仅可使用一次");

	setting.addText((text) => {
		input = text;
		text.setPlaceholder(REDEEM_CODE_PLACEHOLDER).onChange((value) => {
			const sanitized = sanitizeRedeemCodeInput(value);
			if (text.getValue() !== sanitized) text.setValue(sanitized);
			code = sanitized;
		});
		text.inputEl.maxLength = 32;
		text.inputEl.autocapitalize = "characters";
		text.inputEl.autocomplete = "off";
		text.inputEl.spellcheck = false;
	});

	setting.addButton((button) =>
		button.setButtonText("兑换").onClick(async () => {
			if (busy) return;
			const payload = normalizeRedeemCodeInput(code);
			if (!isRedeemCodeCandidate(payload)) {
				setting.setErrorMessage("请输入完整的兑换码");
				return;
			}
			busy = true;
			setting.setErrorMessage(null);
			button.setDisabled(true).setButtonText("兑换中…");
			try {
				const reply = await plugin.client.redeemClient.redeem({ code: payload });
				if (disposed) return;
				new Notice(redeemSuccessText(reply));
				code = "";
				input?.setValue("");
				onRedeemed();
			} catch (err) {
				debugLog.error(`[pickpen] 兑换码兑换失败，错误码：${errorCode(err) ?? "unknown"}`);
				// 服务端结果只走 Notice，不在表单下方常驻红字（与福利码一致）。
				new Notice(redeemErrorMessage(err));
			} finally {
				busy = false;
				button.setDisabled(false).setButtonText("兑换");
			}
		}),
	);

	return () => {
		disposed = true;
	};
}

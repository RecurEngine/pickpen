// 福利码活动状态：由服务端按「当前是否存在可领取的福利码」推导，客户端只缓存结果。
// 刻意不落盘——它是服务端派生值，data.json 会随 iCloud 等同步到其他设备，落盘必然产生陈旧状态。

import { debugLog } from "./debug-log";
import type PickpenPlugin from "./index";
import { errorCode } from "./remote-connect";

/** 福利码默认长度：服务端下发前的兜底，仅用于占住输入框宽度。 */
const DEFAULT_CODE_LENGTH = 6;

// null 表示尚未获知（未登录，或登录后还没请求成功过）
let activityOpen: boolean | null = null;
let codeLength = DEFAULT_CODE_LENGTH;

/** benefitActivityOpen 活动是否开启。谓词只做纯读，绝不在里面发请求。 */
export function benefitActivityOpen(): boolean {
	return activityOpen === true;
}

/** benefitCodeLength 福利码长度（服务端下发，未获知时用默认值）。 */
export function benefitCodeLength(): number {
	return codeLength;
}

/** resetBenefitActivity 退出登录时置回未知。 */
export function resetBenefitActivity(): void {
	activityOpen = null;
}

/**
 * refreshBenefitActivity 拉取活动状态与福利码长度。
 * 未登录时不请求（调用方据此隐藏入口）；请求失败保持上一次结果——
 * 首次失败即保持「未知」（入口不展示），已有结果时不因一次网络抖动让入口闪烁。
 */
export async function refreshBenefitActivity(plugin: PickpenPlugin): Promise<void> {
	if (!plugin.settings.accessToken) {
		activityOpen = null;
		return;
	}

	try {
		const reply = await plugin.client.benefitClient.getBenefitInfo({});
		activityOpen = reply.activityOpen;
		if (reply.codeLength > 0n) {
			codeLength = Number(reply.codeLength);
		}
	} catch (err) {
		debugLog.error(`[pickpen] 福利码活动状态查询失败，错误码：${errorCode(err) ?? "unknown"}`);
	}
}

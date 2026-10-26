// Ribbon 状态渲染：容量已满/阻塞/本地待同步的真实 DOM 徽标（兼容移动端）。

import type { SetupStage } from "./setup-guide";

export const RIBBON_SYNC_ICON = "refresh-cw";
export const RIBBON_SYNC_TITLE = "Pickpen Sync";

/** 徽标语义：容量超限 > 有阻塞文件 > 有本地待同步改动 */
export type RibbonBadgeState = "none" | "pending" | "blocked" | "storage";

export function ribbonBadgeState(input: {
	storageLimitExceeded: boolean;
	pendingCount: number;
	blockedCount: number;
}): RibbonBadgeState {
	if (input.storageLimitExceeded) return "storage";
	if (input.blockedCount > 0) return "blocked";
	if (input.pendingCount > 0) return "pending";
	return "none";
}

/** 幂等同步真实徽标节点；不使用 ::after，避免移动端 Ribbon 丢失伪元素。
 *  颜色由 data-state 决定：pending 主题色 / blocked 黄色 / storage 红色。 */
export function updateRibbonBadge(ribbonEl: HTMLElement, state: RibbonBadgeState): void {
	const badge = ribbonEl.querySelector<HTMLElement>(".pickpen-ribbon-badge");
	if (state === "none") {
		badge?.remove();
		return;
	}
	const target = badge ?? ribbonEl.createSpan({ cls: "pickpen-ribbon-badge" });
	target.setAttribute("aria-hidden", "true");
	target.setAttribute("data-state", state);
}

/** 移动端把 Ribbon 动态复制为 menu-item，只能用受控标题定位对应菜单项。 */
export function isSyncRibbonMenuItem(item: Element): boolean {
	return item.querySelector(".menu-item-title")?.textContent?.trim() === RIBBON_SYNC_TITLE;
}

export interface RibbonLabelInput {
	stage: SetupStage | null; // 配置阶段：login/bind 为未完成，null 为已配置
	storageLimitExceeded: boolean;
	pausedReason: string;
	lastError: string;
	blockedCount: number;
	/** 本地已观察到、尚未确认进入远端的路径数（blocked 不计入） */
	pendingCount: number;
	/** 待处理的冲突副本数（存量）：有它时不显示「已全部同步」——那会把待处理的事盖掉 */
	conflictCount: number;
	lastSyncAt: number;
	allSynced: boolean;
}

// ribbonLabel 悬停与无障碍文案（纯函数）。
// 未配置时同步并未在运行，绝不能显示「已全部同步」；未配置提示优先于暂停/错误，
// 与设置页状态卡片判定一致；存储已满排最前，因为点击 Ribbon 就是先处理容量。
// 「最后同步」是补充信息，最后追加且不参与「有无状态文案」的判定——否则它会顶掉
// 完成态的「已全部同步」，让悬停只剩一个时间戳。
export function ribbonLabel(input: RibbonLabelInput): string {
	const parts: string[] = [];
	if (input.storageLimitExceeded) {
		parts.push("云端存储已满，点击处理");
	} else if (input.stage === "login") {
		parts.push("未登录，点击开始设置");
	} else if (input.stage === "bind") {
		parts.push("未绑定仓库，点击完成设置");
	} else if (input.pausedReason || input.lastError) {
		parts.push(input.pausedReason || "有错误");
	}
	if (input.conflictCount > 0) parts.push(`${input.conflictCount} 个冲突副本待处理`);
	if (input.blockedCount > 0) parts.push(`${input.blockedCount} 个文件未同步`);
	if (input.pendingCount > 0) parts.push(`${input.pendingCount} 项本地改动待同步`);
	if (input.stage === null && input.allSynced && parts.length === 0) parts.push("已全部同步");
	if (input.lastSyncAt) {
		parts.push(`最后同步 ${new Date(input.lastSyncAt).toLocaleTimeString("zh-CN", { hour12: false })}`);
	}
	return parts.length > 0 ? `Pickpen Sync：${parts.join(" ｜ ")}` : "Pickpen Sync";
}

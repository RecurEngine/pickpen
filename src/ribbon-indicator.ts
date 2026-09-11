// Ribbon 容量状态渲染：真实 DOM 徽标兼容移动端，警告图标作为主题隐藏徽标时的兜底。

import type { SetupStage } from "./setup-guide";

export const RIBBON_SYNC_ICON = "refresh-cw";
export const RIBBON_STORAGE_FULL_ICON = "triangle-alert";
export const RIBBON_SYNC_TITLE = "Pickpen Sync";

export function ribbonIcon(storageLimitExceeded: boolean): string {
	return storageLimitExceeded ? RIBBON_STORAGE_FULL_ICON : RIBBON_SYNC_ICON;
}

/** 幂等同步真实徽标节点；不使用 ::after，避免移动端 Ribbon 丢失伪元素。 */
export function updateRibbonBadge(ribbonEl: HTMLElement, storageLimitExceeded: boolean): void {
	const badge = ribbonEl.querySelector<HTMLElement>(".pickpen-ribbon-badge");
	if (!storageLimitExceeded) {
		badge?.remove();
		return;
	}
	if (badge) return;
	const created = ribbonEl.createSpan({ cls: "pickpen-ribbon-badge" });
	created.setAttribute("aria-hidden", "true");
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
	lastSyncAt: number;
	allSynced: boolean;
}

// ribbonLabel 悬停与无障碍文案（纯函数）。
// 未配置时同步并未在运行，绝不能显示「已全部同步」；未配置提示优先于暂停/错误，
// 与设置页状态卡片判定一致；存储已满排最前，因为点击 Ribbon 就是先处理容量。
export function ribbonLabel(input: RibbonLabelInput): string {
	const parts: string[] = [];
	if (input.lastSyncAt) {
		parts.push(`最后同步 ${new Date(input.lastSyncAt).toLocaleTimeString("zh-CN", { hour12: false })}`);
	}
	if (input.storageLimitExceeded) {
		parts.push("云端存储已满，点击处理");
	} else if (input.stage === "login") {
		parts.push("未登录，点击开始设置");
	} else if (input.stage === "bind") {
		parts.push("未绑定仓库，点击完成设置");
	} else if (input.pausedReason || input.lastError) {
		parts.push(input.pausedReason || "有错误");
	}
	if (input.blockedCount > 0) parts.push(`${input.blockedCount} 个文件被阻塞`);
	if (input.stage === null && input.allSynced && parts.length === 0) parts.push("已全部同步");
	return parts.length > 0 ? `Pickpen Sync：${parts.join(" ｜ ")}` : "Pickpen Sync";
}

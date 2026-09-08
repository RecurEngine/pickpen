// Ribbon 容量状态渲染：真实 DOM 徽标兼容移动端，警告图标作为主题隐藏徽标时的兜底。

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

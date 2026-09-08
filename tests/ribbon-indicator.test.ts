import { describe, expect, it } from "vitest";

import {
	RIBBON_STORAGE_FULL_ICON,
	RIBBON_SYNC_ICON,
	isSyncRibbonMenuItem,
	ribbonIcon,
	updateRibbonBadge,
} from "../src/ribbon-indicator";

class FakeBadge {
	removed = false;
	attributes = new Map<string, string>();
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	remove(): void {
		this.removed = true;
	}
}

class FakeRibbon {
	badges: FakeBadge[] = [];
	querySelector(): FakeBadge | null {
		return this.badges.find((badge) => !badge.removed) ?? null;
	}
	createSpan(): FakeBadge {
		const badge = new FakeBadge();
		this.badges.push(badge);
		return badge;
	}
}

describe("移动端 Ribbon 容量状态", () => {
	it("容量状态选择同步或警告图标", () => {
		expect(ribbonIcon(false)).toBe(RIBBON_SYNC_ICON);
		expect(ribbonIcon(true)).toBe(RIBBON_STORAGE_FULL_ICON);
	});

	it("重复刷新超限状态只创建一个真实徽标", () => {
		const ribbon = new FakeRibbon();
		updateRibbonBadge(ribbon as unknown as HTMLElement, true);
		updateRibbonBadge(ribbon as unknown as HTMLElement, true);
		expect(ribbon.badges).toHaveLength(1);
		expect(ribbon.badges[0].attributes.get("aria-hidden")).toBe("true");
	});

	it("容量恢复时删除徽标，之后可再次创建", () => {
		const ribbon = new FakeRibbon();
		updateRibbonBadge(ribbon as unknown as HTMLElement, true);
		updateRibbonBadge(ribbon as unknown as HTMLElement, false);
		expect(ribbon.badges[0].removed).toBe(true);
		updateRibbonBadge(ribbon as unknown as HTMLElement, true);
		expect(ribbon.badges).toHaveLength(2);
	});

	it("只匹配 Obsidian 动态生成的 Pickpen Sync 菜单项", () => {
		const item = (title: string) => ({
			querySelector: () => ({ textContent: title }),
		}) as unknown as Element;
		expect(isSyncRibbonMenuItem(item(" Pickpen Sync "))).toBe(true);
		expect(isSyncRibbonMenuItem(item("Pickpen Sync设置"))).toBe(false);
	});
});

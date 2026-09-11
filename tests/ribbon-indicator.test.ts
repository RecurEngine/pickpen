import { describe, expect, it } from "vitest";

import {
	RIBBON_STORAGE_FULL_ICON,
	RIBBON_SYNC_ICON,
	isSyncRibbonMenuItem,
	ribbonIcon,
	ribbonLabel,
	updateRibbonBadge,
	type RibbonLabelInput,
} from "../src/ribbon-indicator";

const labelInput = (patch: Partial<RibbonLabelInput> = {}): RibbonLabelInput => ({
	stage: null,
	storageLimitExceeded: false,
	pausedReason: "",
	lastError: "",
	blockedCount: 0,
	lastSyncAt: 0,
	allSynced: true,
	...patch,
});

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

describe("Ribbon 文案", () => {
	it("未登录时提示开始设置，绝不显示「已全部同步」", () => {
		const label = ribbonLabel(labelInput({ stage: "login", allSynced: true }));
		expect(label).toBe("Pickpen Sync：未登录，点击开始设置");
		expect(label).not.toContain("已全部同步");
	});

	it("已登录未绑定时提示完成设置", () => {
		expect(ribbonLabel(labelInput({ stage: "bind" }))).toContain("未绑定仓库，点击完成设置");
	});

	it("已配置且无异常时显示已全部同步", () => {
		expect(ribbonLabel(labelInput())).toBe("Pickpen Sync：已全部同步");
	});

	it("保留最后同步时间与阻塞数量", () => {
		const label = ribbonLabel(labelInput({ lastSyncAt: Date.parse("2026-09-11T08:30:00"), blockedCount: 2 }));
		expect(label).toContain("最后同步");
		expect(label).toContain("2 个文件被阻塞");
	});

	it("暂停原因优先于完成态", () => {
		const label = ribbonLabel(labelInput({ pausedReason: "令牌失效，请重新登录" }));
		expect(label).toContain("令牌失效，请重新登录");
		expect(label).not.toContain("已全部同步");
	});

	it("存储已满优先提示处理，与点击行为一致", () => {
		const label = ribbonLabel(labelInput({ stage: "login", storageLimitExceeded: true }));
		expect(label).toContain("云端存储已满，点击处理");
		expect(label).not.toContain("未登录");
	});

	it("无任何状态时只显示插件名", () => {
		expect(ribbonLabel(labelInput({ allSynced: false }))).toBe("Pickpen Sync");
	});
});

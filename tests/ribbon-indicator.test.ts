import { describe, expect, it } from "vitest";

import {
	isSyncRibbonMenuItem,
	ribbonBadgeState,
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
	conflictCount: 0,
	pendingCount: 0,
	lastSyncAt: 0,
	allSynced: true,
	...patch,
});

describe("ribbonLabel 冲突副本提示", () => {
	it("有冲突副本时报数，且不再显示「已全部同步」以免盖掉待处理项", () => {
		expect(ribbonLabel(labelInput({ conflictCount: 2 }))).toBe("Pickpen Sync：2 个冲突副本待处理");
	});
	it("与未同步文件并存时两个都报，顺序为先副本后未同步", () => {
		expect(ribbonLabel(labelInput({ conflictCount: 1, blockedCount: 2 }))).toBe(
			"Pickpen Sync：1 个冲突副本待处理 ｜ 2 个文件未同步",
		);
	});
	it("无冲突副本时维持原样（完成态仍显示已全部同步）", () => {
		expect(ribbonLabel(labelInput({}))).toBe("Pickpen Sync：已全部同步");
	});
});

describe("ribbonLabel 本地待同步提示", () => {
	it("有本地改动尚未到远端时报数，且不再显示「已全部同步」", () => {
		expect(ribbonLabel(labelInput({ pendingCount: 3 }))).toBe("Pickpen Sync：3 项本地改动待同步");
	});
	it("与未同步文件并存时两个都报，顺序为先未同步后待同步", () => {
		expect(ribbonLabel(labelInput({ blockedCount: 1, pendingCount: 2 }))).toBe(
			"Pickpen Sync：1 个文件未同步 ｜ 2 项本地改动待同步",
		);
	});
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

describe("Ribbon 徽标", () => {
	it("徽标优先级：容量已满 > 阻塞文件 > 本地待同步 > 无", () => {
		expect(ribbonBadgeState({ storageLimitExceeded: true, blockedCount: 1, pendingCount: 1 })).toBe("storage");
		expect(ribbonBadgeState({ storageLimitExceeded: false, blockedCount: 1, pendingCount: 1 })).toBe("blocked");
		expect(ribbonBadgeState({ storageLimitExceeded: false, blockedCount: 0, pendingCount: 1 })).toBe("pending");
		expect(ribbonBadgeState({ storageLimitExceeded: false, blockedCount: 0, pendingCount: 0 })).toBe("none");
	});

	it("重复刷新同一状态只创建一个真实徽标", () => {
		const ribbon = new FakeRibbon();
		updateRibbonBadge(ribbon as unknown as HTMLElement, "storage");
		updateRibbonBadge(ribbon as unknown as HTMLElement, "storage");
		expect(ribbon.badges).toHaveLength(1);
		expect(ribbon.badges[0].attributes.get("aria-hidden")).toBe("true");
		expect(ribbon.badges[0].attributes.get("data-state")).toBe("storage");
	});

	it("状态切换复用同一节点并更新 data-state", () => {
		const ribbon = new FakeRibbon();
		updateRibbonBadge(ribbon as unknown as HTMLElement, "pending");
		expect(ribbon.badges).toHaveLength(1);
		expect(ribbon.badges[0].attributes.get("data-state")).toBe("pending");
		updateRibbonBadge(ribbon as unknown as HTMLElement, "blocked");
		expect(ribbon.badges).toHaveLength(1);
		expect(ribbon.badges[0].attributes.get("data-state")).toBe("blocked");
	});

	it("无状态时删除徽标，之后可再次创建", () => {
		const ribbon = new FakeRibbon();
		updateRibbonBadge(ribbon as unknown as HTMLElement, "pending");
		updateRibbonBadge(ribbon as unknown as HTMLElement, "none");
		expect(ribbon.badges[0].removed).toBe(true);
		updateRibbonBadge(ribbon as unknown as HTMLElement, "storage");
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

	it("保留最后同步时间与未同步数量", () => {
		const label = ribbonLabel(labelInput({ lastSyncAt: Date.parse("2026-09-11T08:30:00"), blockedCount: 2 }));
		expect(label).toContain("最后同步");
		expect(label).toContain("2 个文件未同步");
	});

	it("已全部同步时同时显示最后同步时间（时间不顶掉完成态）", () => {
		const label = ribbonLabel(labelInput({ lastSyncAt: Date.parse("2026-09-11T08:30:00") }));
		expect(label).toContain("已全部同步");
		expect(label).toContain("最后同步");
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

import { App, Notice } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";

import { closePluginSettings, focusSelector, openPluginSettings } from "../src/settings";

const noticeMessages = (): unknown[] => (Notice as unknown as { messages: unknown[] }).messages;

describe("系统设置导航", () => {
	beforeEach(() => {
		noticeMessages().length = 0;
	});

	it("先打开系统设置，再选中 Pickpen Sync 插件页", () => {
		const calls: string[] = [];
		const app = {
			setting: {
				open: () => calls.push("open"),
				openTabById: (id: string) => calls.push(`tab:${id}`),
			},
		} as unknown as App;

		expect(openPluginSettings(app, "pickpen")).toBe(true);
		expect(calls).toEqual(["open", "tab:pickpen"]);
		expect(noticeMessages()).toEqual([]);
	});

	it("宿主缺少设置接口时安全失败并提示手动进入", () => {
		const app = {} as App;

		expect(openPluginSettings(app, "pickpen")).toBe(false);
		expect(noticeMessages()).toEqual(["无法自动打开设置，请在 Obsidian 系统设置中选择 Pickpen Sync"]);
	});

	it("关闭设置页：调用宿主控制器，接口缺失时静默降级（跳转仍应发生）", () => {
		const calls: string[] = [];
		const app = { setting: { close: () => calls.push("close") } } as unknown as App;
		closePluginSettings(app);
		expect(calls).toEqual(["close"]);

		// 宿主未提供 close 时不得抛错：跳转不该因为关不掉设置页而失败
		expect(() => closePluginSettings({ setting: {} } as unknown as App)).not.toThrow();
		expect(() => closePluginSettings({} as App)).not.toThrow();
	});

	it("聚焦选择器与设置页 class 命名契约一致", () => {
		expect(focusSelector("account")).toBe(".pickpen-account-section");
		expect(focusSelector("subscription")).toBe(".pickpen-subscription-plans");
	});
});

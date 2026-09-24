// 设置页分区结构：原「同步」与「选择性同步」已合并为单一「同步」区（位于「账号和仓库」下面）。
// 本测试锁住分区顺序与关键词，防止又长出一个独立分区、或把已下线的条目（排除项追加 / 冲突策略 / 变更防抖）加回来。

import { App, type SettingDefinitionGroup } from "obsidian";
import { describe, expect, it } from "vitest";

import type PickpenPlugin from "../src/index";
import { PickpenSettingTab } from "../src/settings";

function sectionGroups(): SettingDefinitionGroup[] {
	const app = { vault: { configDir: ".obsidian" } } as unknown as App;
	const plugin = {
		app,
		manifest: { id: "pickpen", dir: ".obsidian/plugins/pickpen" },
	} as unknown as PickpenPlugin;
	return new PickpenSettingTab(app, plugin).getSettingDefinitions() as SettingDefinitionGroup[];
}

/** 分组内承载具体设置的声明行（name/desc/aliases 供设置搜索检索） */
function indexText(groups: SettingDefinitionGroup[]): string {
	return JSON.stringify(groups.map((g) => ({ heading: g.heading, items: g.items })));
}

describe("设置页分区", () => {
	it("分区顺序：同步区紧随账号区，且全局只有一个「同步」", () => {
		const headings = sectionGroups().map((g) => g.heading);
		expect(headings).toEqual([
			"账号和仓库",
			"同步",
			"邀请",
			"当前订阅",
			"订阅方案",
			"诊断",
			"关于与反馈",
		]);
	});

	it("同步区索引同时覆盖选择性同步与原同步区的入口", () => {
		const sync = sectionGroups().find((g) => g.heading === "同步");
		const aliases = (sync?.items?.[0] as { aliases?: string[] } | undefined)?.aliases ?? [];
		for (const keyword of [
			"选择性同步", "同步图片", "同步音频", "同步视频", "同步 PDF", "其他类型",
			"排除文件夹", "同步配置文件", "主要设置", "外观", "快捷键", "核心插件", "第三方插件",
			"已删除的文件", "恢复",
		]) {
			expect(aliases).toContain(keyword);
		}
	});

	it("已下线的条目不再出现在设置页", () => {
		const text = indexText(sectionGroups());
		for (const removed of ["排除项追加", "冲突策略", "变更防抖"]) {
			expect(text).not.toContain(removed);
		}
	});
});

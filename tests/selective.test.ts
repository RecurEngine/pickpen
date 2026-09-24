// 选择性同步过滤（specs/sync/spec.md 需求 1）：类型白名单、排除文件夹、配置目录分类与枚举。
// 口径与 Obsidian 官方同步逐条对齐（扩展名清单、配置分类文件名映射、默认值）。
import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import {
	anyConfigEnabled,
	classifyFileType,
	createSyncFilter,
	defaultSelectiveSettings,
	normalizeSelectiveSettings,
	type SelectiveConfigSettings,
	type SelectiveSettings,
} from "../src/sync/selective";

const CONFIG_DIR = ".obsidian";
const SELF_DIR = ".obsidian/plugins/pickpen";

function filter(over: {
	selective?: Partial<Omit<SelectiveSettings, "config">>;
	config?: Partial<SelectiveConfigSettings>;
	configDir?: string;
	selfDir?: string;
} = {}) {
	const defaults = defaultSelectiveSettings();
	return createSyncFilter({
		selective: {
			...defaults,
			...over.selective,
			excludedFolders: over.selective?.excludedFolders ?? [],
			config: { ...defaults.config, ...over.config },
		},
		configDir: over.configDir ?? CONFIG_DIR,
		selfDir: over.selfDir ?? SELF_DIR,
		selfId: "pickpen",
	});
}

/** 全部分类关闭的设置（除 over 指定项） */
function configOff(over: Partial<SelectiveConfigSettings> = {}): Partial<SelectiveConfigSettings> {
	const off: Partial<SelectiveConfigSettings> = {};
	for (const key of Object.keys(defaultSelectiveSettings().config) as (keyof SelectiveConfigSettings)[]) {
		off[key] = false;
	}
	return { ...off, ...over };
}

describe("默认值与归一化", () => {
	it("默认：图片/音频/视频/PDF 开、其他类型关；配置前 6 类开、第三方插件两类关", () => {
		const d = defaultSelectiveSettings();
		expect([d.images, d.audio, d.video, d.pdf, d.other]).toEqual([true, true, true, true, false]);
		expect(d.config).toEqual({
			app: true,
			appearance: true,
			appearanceData: true,
			hotkey: true,
			corePlugin: true,
			corePluginData: true,
			communityPlugin: false,
			communityPluginData: false,
		});
		expect(d.excludedFolders).toEqual([]);
		expect(anyConfigEnabled(d)).toBe(true);
		expect(anyConfigEnabled(normalizeSelectiveSettings({ config: configOff() }))).toBe(false);
	});

	it("缺失/脏数据按默认值补齐，不把过滤打穿成空集", () => {
		const s = normalizeSelectiveSettings(undefined);
		expect(s.config.corePlugin).toBe(true);
		const bad = normalizeSelectiveSettings({ images: "yes", other: 1, excludedFolders: ["a/", "", 7], config: null });
		expect(bad.images).toBe(true); // 非布尔 → 默认
		expect(bad.other).toBe(false);
		expect(bad.excludedFolders).toEqual(["a"]); // 只留字符串并 normalize
		expect(bad.config.app).toBe(true); // config 缺失 → 全部默认
	});

	it("默认值每次现造，改一份不污染另一份", () => {
		const a = defaultSelectiveSettings();
		a.config.app = false;
		a.excludedFolders.push("x");
		expect(defaultSelectiveSettings().config.app).toBe(true);
		expect(defaultSelectiveSettings().excludedFolders).toEqual([]);
	});
});

describe("文件类型白名单（官方扩展名清单）", () => {
	it("分类大小写不敏感", () => {
		expect(classifyFileType("a.PNG")).toBe("image");
		expect(classifyFileType("dir/a.Mp4")).toBe("video");
		expect(classifyFileType("a.MD")).toBe("note");
		expect(classifyFileType("README")).toBe("other");
		expect(classifyFileType("a.base")).toBe("note");
	});

	it("笔记格式恒同步，其余按类型开关", () => {
		const f = filter({ selective: { images: false, audio: false, video: false, pdf: false, other: false } });
		expect(f.isExcluded("note.md")).toBe(false);
		expect(f.isExcluded("board.canvas")).toBe(false);
		expect(f.isExcluded("vault.base")).toBe(false);
		expect(f.isExcluded("pic.png")).toBe(true);
		expect(f.isExcluded("snd.mp3")).toBe(true);
		expect(f.isExcluded("mov.mkv")).toBe(true);
		expect(f.isExcluded("doc.pdf")).toBe(true);
		expect(f.isExcluded("data.txt")).toBe(true);
	});

	it("其余类型关闭时排除无扩展名文件，开启后放行", () => {
		expect(filter().isExcluded("script.sh")).toBe(true);
		expect(filter({ selective: { other: true } }).isExcluded("script.sh")).toBe(false);
	});

	it("webm 按音频或视频任一开启放行（官方口径）", () => {
		expect(filter({ selective: { video: false } }).isExcluded("clip.webm")).toBe(false); // 音频仍开
		expect(filter({ selective: { audio: false } }).isExcluded("clip.webm")).toBe(false); // 视频仍开
		expect(filter({ selective: { audio: false, video: false } }).isExcluded("clip.webm")).toBe(true);
	});

	it("默认设置放行图片/音频/视频/PDF，排除其他类型", () => {
		const f = filter();
		expect(f.isExcluded("a/b.png")).toBe(false);
		expect(f.isExcluded("a/b.m4a")).toBe(false);
		expect(f.isExcluded("a/b.mov")).toBe(false);
		expect(f.isExcluded("a/b.pdf")).toBe(false);
		expect(f.isExcluded("a/b.xlsx")).toBe(true);
	});

	it("目录条目不受类型白名单影响（目录是结构，没有扩展名）", () => {
		const f = filter(); // other 默认关
		expect(f.isExcluded("notes", true)).toBe(false);
		expect(f.isExcluded("notes/2026", true)).toBe(false);
		expect(f.isExcluded("notes", false)).toBe(true); // 无扩展名的普通文件仍被排除
	});
});

describe("排除清单与排除文件夹", () => {
	it("内建默认清单仍生效（用户可见的排除只有「排除文件夹」）", () => {
		const f = filter({ selective: { other: true } }); // 类型全开，排除项只剩内建清单
		expect(f.isExcluded(".trash/a.md")).toBe(true);
		expect(f.isExcluded("a/b.tmp")).toBe(true);
		expect(f.isExcluded("~$a.md")).toBe(true);
		expect(f.isExcluded(".DS_Store")).toBe(true);
		expect(f.isExcluded("Thumbs.db")).toBe(true);
		// 「排除项追加」已下线：不再有任何用户自定义的通配/路径规则生效
		expect(f.isExcluded("chart.drawio")).toBe(false);
		expect(f.isExcluded("private/secret.md")).toBe(false);
	});

	it("排除文件夹命中目录自身与整棵子树", () => {
		const f = filter({ selective: { excludedFolders: ["private", "notes/draft"] } });
		expect(f.isExcluded("private", true)).toBe(true);
		expect(f.isExcluded("private/a.md")).toBe(true);
		expect(f.isExcluded("private/deep/a.png")).toBe(true);
		expect(f.isExcluded("notes/draft", true)).toBe(true);
		expect(f.isExcluded("notes/draft/x.md")).toBe(true);
		expect(f.isExcluded("private2/a.md")).toBe(false);
		expect(f.isExcluded("notes/other.md")).toBe(false);
	});

	it("隐藏路径一律排除", () => {
		const f = filter();
		expect(f.isExcluded(".git/config")).toBe(true);
		expect(f.isExcluded("a/.hidden.md")).toBe(true);
	});
});

describe("配置目录分类（对齐官方文件名映射）", () => {
	it("默认分类覆盖：主要设置/外观/主题与片段/快捷键/核心插件启用与设置", () => {
		const f = filter();
		for (const p of [
			".obsidian/app.json",
			".obsidian/types.json",
			".obsidian/appearance.json",
			".obsidian/hotkeys.json",
			".obsidian/core-plugins.json",
			".obsidian/core-plugins-migration.json",
			".obsidian/graph.json", // 其余顶层 *.json = 核心插件设置
			".obsidian/bookmarks.json",
			".obsidian/themes/Blue Topaz/theme.css",
			".obsidian/themes/Blue Topaz/manifest.json",
			".obsidian/snippets/tweak.css",
		]) {
			expect(f.isExcluded(p), p).toBe(false);
			expect(f.isConfigPath(p), p).toBe(true);
		}
	});

	it("第三方插件两项默认关：社区插件列表与插件目录都不同步", () => {
		const f = filter();
		expect(f.isExcluded(".obsidian/community-plugins.json")).toBe(true);
		for (const p of [
			".obsidian/plugins/dataview/manifest.json",
			".obsidian/plugins/dataview/main.js",
			".obsidian/plugins/dataview/styles.css",
			".obsidian/plugins/dataview/data.json",
		]) {
			expect(f.isExcluded(p), p).toBe(true);
		}
	});

	it("开启第三方插件两项后：仅这四个文件名与社区插件列表进入同步范围", () => {
		const f = filter({ config: { communityPlugin: true, communityPluginData: true } });
		expect(f.isExcluded(".obsidian/community-plugins.json")).toBe(false);
		expect(f.isExcluded(".obsidian/plugins/dataview/manifest.json")).toBe(false);
		expect(f.isExcluded(".obsidian/plugins/dataview/main.js")).toBe(false);
		expect(f.isExcluded(".obsidian/plugins/dataview/styles.css")).toBe(false);
		expect(f.isExcluded(".obsidian/plugins/dataview/data.json")).toBe(false);
		expect(f.isExcluded(".obsidian/plugins/dataview/README.md")).toBe(true);
		expect(f.isExcluded(".obsidian/plugins/dataview/nested/extra.js")).toBe(true);
	});

	it("pickpen 自身插件目录永不进入（含同步基线/待办/临时区）", () => {
		const f = filter({ config: { communityPluginData: true } });
		for (const p of [
			".obsidian/plugins/pickpen/main.js",
			".obsidian/plugins/pickpen/data.json",
			".obsidian/plugins/pickpen/sync-base.json",
			".obsidian/plugins/pickpen/sync-pending-v2.json",
			".obsidian/plugins/pickpen/tmp/abc",
		]) {
			expect(f.isExcluded(p), p).toBe(true);
		}
	});

	it("workspace*.json 与 sync.json、隐藏段、node_modules、非白名单文件一律不同步", () => {
		const f = filter({ config: { communityPlugin: true, communityPluginData: true } });
		for (const p of [
			".obsidian/workspace.json",
			".obsidian/workspace-mobile.json",
			".obsidian/sync.json",
			".obsidian/.hidden/config.json",
			".obsidian/node_modules/pkg/index.js",
			".obsidian/themes/Blue Topaz/other.css",
			".obsidian/snippets/tweak.js",
			".obsidian/cache.bin",
			".obsidian/plugins/dataview",
		]) {
			expect(f.isExcluded(p, p === ".obsidian/plugins/dataview"), p).toBe(true);
		}
	});

	it("配置分类全部关闭时，配置目录内全部排除", () => {
		const f = filter({ config: configOff() });
		expect(f.configEnabled()).toBe(false);
		expect(f.isExcluded(".obsidian/app.json")).toBe(true);
		expect(f.isExcluded(".obsidian/appearance.json")).toBe(true);
		expect(f.isExcluded(".obsidian/themes/x/theme.css")).toBe(true);
	});

	it("单项关闭只影响该分类", () => {
		const f = filter({ config: { hotkey: false, appearanceData: false } });
		expect(f.isExcluded(".obsidian/hotkeys.json")).toBe(true);
		expect(f.isExcluded(".obsidian/snippets/tweak.css")).toBe(true);
		expect(f.isExcluded(".obsidian/app.json")).toBe(false);
		expect(f.isExcluded(".obsidian/graph.json")).toBe(false);
	});

	it("自定义配置目录名（非点号 profile）同样按分类判定，且目录内其它文件不泄漏", () => {
		const f = filter({ configDir: "config", selfDir: "config/plugins/pickpen" });
		expect(f.isExcluded("config/app.json")).toBe(false);
		expect(f.isExcluded("config/themes/x/theme.css")).toBe(false);
		expect(f.isExcluded("config/random.txt")).toBe(true);
		expect(f.isExcluded("config/plugins/pickpen/main.js")).toBe(true);
	});

	it("配置目录内的文件不受类型白名单影响（CSS 片段不因「其他类型」关闭而失效）", () => {
		const f = filter(); // other 默认关
		expect(f.isExcluded(".obsidian/snippets/tweak.css")).toBe(false);
	});
});

describe("配置目录枚举 scanConfigFiles", () => {
	function fakeAdapter(listing: Record<string, { files: string[]; folders: string[] }>, onList?: (p: string) => void): DataAdapter {
		return {
			list: async (path: string) => {
				onList?.(path);
				return listing[path] ?? { files: [], folders: [] };
			},
		} as unknown as DataAdapter;
	}

	const listing = {
		".obsidian": {
			files: [".obsidian/app.json", ".obsidian/workspace.json", ".obsidian/community-plugins.json", ".obsidian/other.txt"],
			folders: [".obsidian/themes", ".obsidian/snippets", ".obsidian/plugins", ".obsidian/cache"],
		},
		".obsidian/themes": { files: [], folders: [".obsidian/themes/Blue Topaz"] },
		".obsidian/themes/Blue Topaz": {
			files: [".obsidian/themes/Blue Topaz/theme.css", ".obsidian/themes/Blue Topaz/README.md"],
			folders: [],
		},
		".obsidian/snippets": { files: [".obsidian/snippets/tweak.css", ".obsidian/snippets/note.md"], folders: [] },
		".obsidian/plugins": { files: [], folders: [".obsidian/plugins/dataview", ".obsidian/plugins/pickpen"] },
		".obsidian/plugins/dataview": {
			files: [".obsidian/plugins/dataview/main.js", ".obsidian/plugins/dataview/data.json"],
			folders: [],
		},
		".obsidian/plugins/pickpen": {
			files: [".obsidian/plugins/pickpen/main.js", ".obsidian/plugins/pickpen/sync-base.json"],
			folders: [],
		},
	};

	it("只返回分类允许的文件，不下潜无关目录", async () => {
		const f = filter();
		const listed: string[] = [];
		const files = await f.scanConfigFiles(fakeAdapter(listing, (p) => listed.push(p)));
		expect(files.sort()).toEqual([
			".obsidian/app.json",
			".obsidian/snippets/tweak.css",
			".obsidian/themes/Blue Topaz/theme.css",
		]);
		expect(listed).not.toContain(".obsidian/plugins"); // 第三方插件目录关闭时不下潜
		expect(listed).not.toContain(".obsidian/cache");
	});

	it("开启第三方插件目录后下潜，但自身插件目录仍被跳过", async () => {
		const f = filter({ config: { communityPluginData: true } });
		const listed: string[] = [];
		const files = await f.scanConfigFiles(fakeAdapter(listing, (p) => listed.push(p)));
		expect(files.sort()).toEqual([
			".obsidian/app.json",
			".obsidian/plugins/dataview/data.json",
			".obsidian/plugins/dataview/main.js",
			".obsidian/snippets/tweak.css",
			".obsidian/themes/Blue Topaz/theme.css",
		]);
		expect(listed).toContain(".obsidian/plugins/dataview");
		expect(listed).not.toContain(".obsidian/plugins/pickpen");
	});

	it("分类全关时不触碰 adapter", async () => {
		const onList = vi.fn();
		const files = await filter({ config: configOff() }).scanConfigFiles(fakeAdapter(listing, onList));
		expect(files).toEqual([]);
		expect(onList).not.toHaveBeenCalled();
	});

	it("adapter 不支持 list 时安全返回空", async () => {
		const files = await filter().scanConfigFiles({} as DataAdapter);
		expect(files).toEqual([]);
	});
});

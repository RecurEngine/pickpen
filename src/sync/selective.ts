// 选择性同步过滤（specs/sync/spec.md 需求 1）：类型白名单 + 排除文件夹 + 配置目录分类。
//
// 口径对齐 Obsidian 官方同步：
// - 笔记格式（md/canvas/base）恒同步，不受任何开关影响；
// - 类型扩展名清单与默认值（图片/音频/视频/PDF 开、其他类型关）逐条一致，webm 按音频或视频任一开启放行；
// - 配置目录内只同步「官方分类」覆盖到的文件（分类名一一对应），workspace*.json 与隐藏段、
//   node_modules 段永不进入；
// - pickpen 自身插件目录（含同步基线/待办/临时区）永不进入同步范围。
//
// 本模块只做纯路径判定与配置目录枚举；扫描与对账两侧必须共用同一个实例，
// 否则同一轮里「哪些路径可见」会出现两种口径。

import type { DataAdapter } from "obsidian";

import { debugLog } from "../debug-log";
import { DEFAULT_EXCLUDES, isHidden, matchPattern, normalize } from "../excludes";

/** 文件类型分类（note = 笔记格式，恒同步） */
export type FileKind = "note" | "image" | "audio" | "video" | "pdf" | "other";

// 扩展名清单逐条对齐官方：图片 hb / 音频 pb / 视频 db / PDF fb
// （导出供设置面板展示「同步以下类型的…文件：」文案，避免两处各写一份）
export const NOTE_EXTS = ["md", "canvas", "base"];
export const IMAGE_EXTS = ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
export const AUDIO_EXTS = ["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus"];
export const VIDEO_EXTS = ["mp4", "webm", "ogv", "mov", "mkv"];
export const PDF_EXTS = ["pdf"];

/** 配置目录内的分类（键名对应官方分类 app / appearance / appearance-data / hotkey /
 * core-plugin / core-plugin-data / community-plugin / community-plugin-data） */
export interface SelectiveConfigSettings {
	app: boolean; // app.json、types.json
	appearance: boolean; // appearance.json
	appearanceData: boolean; // themes/<名>/{theme.css,manifest.json}、snippets/<名>.css
	hotkey: boolean; // hotkeys.json
	corePlugin: boolean; // core-plugins.json、core-plugins-migration.json
	corePluginData: boolean; // 配置目录下其余顶层 *.json（核心插件设置）
	communityPlugin: boolean; // community-plugins.json
	communityPluginData: boolean; // plugins/<id>/{manifest.json,main.js,styles.css,data.json}
}

/** 选择性同步设置（data.json 的 selective 键） */
export interface SelectiveSettings {
	images: boolean;
	audio: boolean;
	video: boolean;
	pdf: boolean;
	other: boolean; // 其他所有类型文件（无法在 Obsidian 中打开的文件）
	excludedFolders: string[];
	config: SelectiveConfigSettings;
}

/** 官方默认值：图片/音频/视频/PDF 开、其他类型关；前 6 个配置分类开、第三方插件两项关 */
export function defaultSelectiveSettings(): SelectiveSettings {
	return {
		images: true,
		audio: true,
		video: true,
		pdf: true,
		other: false,
		excludedFolders: [],
		config: {
			app: true,
			appearance: true,
			appearanceData: true,
			hotkey: true,
			corePlugin: true,
			corePluginData: true,
			communityPlugin: false,
			communityPluginData: false,
		},
	};
}

/** 载入兜底：缺键/脏值按默认值补齐（升级新增键、手改 data.json 都不至于把过滤打穿） */
export function normalizeSelectiveSettings(raw: unknown): SelectiveSettings {
	const defaults = defaultSelectiveSettings();
	const src = (raw ?? {}) as Partial<SelectiveSettings>;
	const config = (src.config ?? {}) as Partial<SelectiveConfigSettings>;
	const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
	return {
		images: bool(src.images, defaults.images),
		audio: bool(src.audio, defaults.audio),
		video: bool(src.video, defaults.video),
		pdf: bool(src.pdf, defaults.pdf),
		other: bool(src.other, defaults.other),
		excludedFolders: Array.isArray(src.excludedFolders)
			? src.excludedFolders
					.filter((p): p is string => typeof p === "string" && p !== "")
					// 去尾部斜杠：排除项按前缀匹配，'private/' 与 'private' 必须等价
					.map((p) => normalize(p).replace(/\/+$/, ""))
					.filter((p) => p !== "")
			: [],
		config: {
			app: bool(config.app, defaults.config.app),
			appearance: bool(config.appearance, defaults.config.appearance),
			appearanceData: bool(config.appearanceData, defaults.config.appearanceData),
			hotkey: bool(config.hotkey, defaults.config.hotkey),
			corePlugin: bool(config.corePlugin, defaults.config.corePlugin),
			corePluginData: bool(config.corePluginData, defaults.config.corePluginData),
			communityPlugin: bool(config.communityPlugin, defaults.config.communityPlugin),
			communityPluginData: bool(config.communityPluginData, defaults.config.communityPluginData),
		},
	};
}

/** 配置分类是否全部关闭（关闭时不触碰配置目录，省掉一轮 I/O） */
export function anyConfigEnabled(settings: SelectiveSettings): boolean {
	const c = settings.config;
	return (
		c.app ||
		c.appearance ||
		c.appearanceData ||
		c.hotkey ||
		c.corePlugin ||
		c.corePluginData ||
		c.communityPlugin ||
		c.communityPluginData
	);
}

/** 小写扩展名（无扩展名返回 ""） */
function extLower(path: string): string {
	const base = path.split("/").pop() ?? path;
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function baseName(path: string): string {
	return path.split("/").pop() ?? path;
}

/** 文件类型分类（webm 归视频；是否放行见 typeAllowed 的音频或视频任一开启规则） */
export function classifyFileType(path: string): FileKind {
	const ext = extLower(path);
	if (NOTE_EXTS.includes(ext)) return "note";
	if (IMAGE_EXTS.includes(ext)) return "image";
	if (VIDEO_EXTS.includes(ext)) return "video";
	if (AUDIO_EXTS.includes(ext)) return "audio";
	if (PDF_EXTS.includes(ext)) return "pdf";
	return "other";
}

/** 类型是否放行：笔记恒放行；webm 音频或视频任一开即放行；其余按所属类型开关 */
export function typeAllowed(path: string, settings: SelectiveSettings): boolean {
	const ext = extLower(path);
	if (ext === "webm") return settings.audio || settings.video;
	switch (classifyFileType(path)) {
		case "note":
			return true;
		case "image":
			return settings.images;
		case "audio":
			return settings.audio;
		case "video":
			return settings.video;
		case "pdf":
			return settings.pdf;
		default:
			return settings.other;
	}
}

/** 配置目录内：是否为官方分类覆盖到的文件（且对应分类开启） */
function configFileAllowed(rel: string, settings: SelectiveSettings): boolean {
	const segs = rel.split("/");
	if (segs.some((seg) => seg === "node_modules" || seg.startsWith("."))) return false;
	const name = baseName(rel);
	const ext = extLower(rel);
	if (rel === "workspace.json" || rel === "workspace-mobile.json" || rel === "sync.json") return false;
	const c = settings.config;
	if (rel === "app.json" || rel === "types.json") return c.app;
	if (rel === "appearance.json") return c.appearance;
	if (rel === "hotkeys.json") return c.hotkey;
	if (rel === "core-plugins.json" || rel === "core-plugins-migration.json") return c.corePlugin;
	if (rel === "community-plugins.json") return c.communityPlugin;
	if (segs[0] === "themes" && segs.length === 3 && (name === "theme.css" || name === "manifest.json")) {
		return c.appearanceData;
	}
	if (segs[0] === "snippets" && segs.length === 2 && ext === "css") return c.appearanceData;
	if (segs.length === 1 && ext === "json") return c.corePluginData;
	if (segs[0] === "plugins" && segs.length === 3 && isPluginFile(name)) return c.communityPluginData;
	return false;
}

/** 第三方插件的文件面：仅这四个文件名进入同步 */
function isPluginFile(name: string): boolean {
	return name === "manifest.json" || name === "main.js" || name === "styles.css" || name === "data.json";
}

export interface SyncFilterOptions {
	selective: SelectiveSettings;
	/** 配置目录名（vault.configDir，通常为 .obsidian；可能是自定义 profile 名） */
	configDir: string;
	/** pickpen 自身插件目录（manifest.dir，normalize 后）；空串 = 未知，则只按插件 id 排除 */
	selfDir: string;
	/** 插件 id（manifest.id）：配置目录下同名插件目录一并排除 */
	selfId: string;
}

export interface SyncFilter {
	/** 配置目录（normalize 后；可能为空串 = 未配置） */
	readonly configDir: string;
	/**
	 * 全量排除判定（旧排除清单 + 排除文件夹 + 配置目录分类 + 隐藏 + 类型）。
	 * isDir = 目录条目：目录是结构而不是「文件类型」，类型白名单对它不适用
	 * （目录没有扩展名，否则会被当成「其他类型文件」而被默认关闭挡掉）
	 */
	isExcluded(path: string, isDir?: boolean): boolean;
	/** 是否位于配置目录内（这些路径不在 vault 索引里，只能走 adapter 读写） */
	isConfigPath(path: string): boolean;
	/** 是否存在启用的配置分类 */
	configEnabled(): boolean;
	/** 枚举配置目录内允许同步的文件路径（normalize 后）；未启用任何分类或 adapter 不支持 list 时返回空 */
	scanConfigFiles(adapter: DataAdapter): Promise<string[]>;
}

/** 建一个过滤实例。一次同步轮次内只建一个，扫描与对账共用。 */
export function createSyncFilter(opts: SyncFilterOptions): SyncFilter {
	// 设置可能来自未归一化的来源（旧 data.json、测试桩）：这里再兜一次底，
	// 缺字段不该把「同步范围」判成空集或抛异常
	const selective = normalizeSelectiveSettings(opts.selective);
	const configDir = normalize(opts.configDir ?? "");
	const configPrefix = configDir ? `${configDir}/` : "";
	const selfDir = normalize(opts.selfDir ?? "");
	const selfId = opts.selfId ?? "";
	const folders = selective.excludedFolders.map(normalize).filter((f) => f !== "");
	const cfg = selective.config;
	const configOn = anyConfigEnabled(selective);

	const isConfigPath = (path: string): boolean => configPrefix !== "" && path.startsWith(configPrefix);

	/** 配置目录下某个目录是否需要继续下潜（只有分类覆盖的子树才枚举） */
	const descendAllowed = (relDir: string): boolean => {
		const segs = relDir.split("/").filter((s) => s !== "");
		if (segs.some((seg) => seg === "node_modules" || seg.startsWith("."))) return false;
		if (segs.length === 0) return true; // 配置目录本身
		if (segs[0] === "themes") return cfg.appearanceData && segs.length < 3;
		if (segs[0] === "snippets") return cfg.appearanceData && segs.length < 2;
		if (segs[0] === "plugins") return cfg.communityPluginData && segs.length < 3 && segs[1] !== selfId;
		return false; // 顶层其余目录：核心插件设置在顶层 *.json，无需下潜
	};

	const isExcluded = (path: string, isDir = false): boolean => {
		const p = normalize(path);
		if (p === "") return true;
		for (const pattern of DEFAULT_EXCLUDES) {
			if (pattern && matchPattern(p, pattern)) return true;
		}
		for (const folder of folders) {
			if (p === folder || p.startsWith(folder + "/")) return true;
		}
		// pickpen 自身插件目录：含同步基线/待办/临时区，绝不能进同步范围
		if (selfDir !== "" && (p === selfDir || p.startsWith(selfDir + "/"))) return true;
		if (isConfigPath(p)) {
			if (selfId !== "" && p.startsWith(`${configPrefix}plugins/${selfId}/`)) return true;
			return !configFileAllowed(p.slice(configPrefix.length), selective);
		}
		if (isHidden(p)) return true;
		if (isDir) return false; // 目录是结构：只受排除清单与排除文件夹约束
		return !typeAllowed(p, selective);
	};

	const scanConfigFiles = async (adapter: DataAdapter): Promise<string[]> => {
		if (!configOn || configPrefix === "") return [];
		if (typeof adapter.list !== "function") {
			debugLog.warn("[pickpen] adapter 不支持 list，跳过配置目录扫描");
			return [];
		}
		const out: string[] = [];
		const walk = async (relDir: string): Promise<void> => {
			let listing: { files: string[]; folders: string[] };
			try {
				listing = await adapter.list(relDir === "" ? configDir : `${configPrefix}${relDir}`);
			} catch (err) {
				debugLog.warn(`[pickpen] 枚举配置目录失败（${relDir || configDir}）：${String(err)}`);
				return;
			}
			for (const file of listing.files) {
				const p = normalize(file);
				// 文件名/深度/分类判定统一走 isExcluded，避免两处规则漂移
				if (!isExcluded(p)) out.push(p);
			}
			for (const folder of listing.folders) {
				const rel = relDir === "" ? baseName(normalize(folder)) : `${relDir}/${baseName(normalize(folder))}`;
				if (!descendAllowed(rel)) continue;
				await walk(rel);
			}
		};
		await walk("");
		return out;
	};

	return { configDir, isExcluded, isConfigPath, configEnabled: () => configOn, scanConfigFiles };
}

// Obsidian API stub（vitest node 环境）：obsidian 包是纯类型库（无运行时导出），
// 测试经 vitest alias 解析到本文件。仅提供测试路径使用的运行时符号。

export const Platform = {
	isMobile: false,
	isDesktopApp: true,
	isIosApp: false,
	isAndroidApp: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
};

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}

export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}
export class Vault {
	// stub：不建模 adapter/getBasePath，vaultScopeKey 在测试中不调用
	adapter: unknown = null;
}
export class App { vault = new Vault(); }
export class FileSystemAdapter {}
export class Plugin {}
export class MarkdownView {}
export class Notice {
	static messages: unknown[] = [];
	constructor(message?: unknown) {
		Notice.messages.push(message);
	}
}
export class Modal {}
export class Setting {}
export class PluginSettingTab {}
export class ButtonComponent {}
export class ToggleComponent {}
export class Component {}
export const MarkdownRenderer = {}

export type EventRef = unknown;
export type App2 = App;

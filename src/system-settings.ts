// Obsidian 系统设置入口的统一封装（设置页与版本升级弹窗共用）。
// 独立成文件是为了避免 about/version-gate 反向引用 settings.ts 形成模块环。
// Obsidian 尚未公开声明设置控制器类型：这里集中断言并保留接口缺失时的安全降级。

import type { App } from "obsidian";

interface ObsidianSettingsController {
	open(): void;
	openTabById(id: string): void;
	close(): void;
}

/** 协议处理器（宿主内部实现，未公开声明）。1.14 为 protocolHandler 对象，移动端/旧版本为 protocolHandlers Map */
interface ObsidianProtocolHandler {
	dispatch?: (params: Record<string, string>) => void;
}

interface ObsidianProtocolHandlers {
	protocolHandler?: ObsidianProtocolHandler;
	protocolHandlers?: Map<string, (params: Record<string, string>) => unknown>;
}

/**
 * openSettingsTab 打开 Obsidian 系统设置并切到指定页签（插件 id 或 "community-plugins"）。
 * 页签切换失败时停留在设置首页，仍返回 true；接口整体缺失返回 false，由调用方给出手动指引。
 */
export function openSettingsTab(app: App, tabId: string): boolean {
	const setting = (app as App & { setting?: Partial<ObsidianSettingsController> }).setting;
	if (typeof setting?.open !== "function") return false;
	setting.open();
	try {
		setting.openTabById?.(tabId);
	} catch {
		// 页签不存在时停在设置首页，不影响用户手动查找
	}
	return true;
}

/**
 * openCommunityPluginPage 打开插件市场里本插件的详情页——与 obsidian://show-plugin?id=<id> 完全等效，
 * 详情页上可直接点「更新」。优先调用宿主内部协议处理器（不经过系统浏览器，也不打断当前窗口）；
 * 处理器不可用时退回「设置 → 第三方插件」列表，那里同样能点「检查更新」。
 */
export function openCommunityPluginPage(app: App, pluginId: string): boolean {
	const workspace = app.workspace as typeof app.workspace & ObsidianProtocolHandlers;
	// 与宿主接收 obsidian:// 链接时一致：params 含 action 与查询参数
	const params = { action: "show-plugin", id: pluginId };
	if (typeof workspace.protocolHandler?.dispatch === "function") {
		workspace.protocolHandler.dispatch(params);
		return true;
	}
	const legacy = workspace.protocolHandlers?.get("show-plugin");
	if (typeof legacy === "function") {
		legacy(params);
		return true;
	}
	return openSettingsTab(app, "community-plugins");
}

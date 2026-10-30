// 全局错误钩子：只接收本插件 main.js 产生的错误。
// window.error 也会收到 Obsidian 与其他插件的错误，必须按脚本路径过滤，否则会收集第三方信息。
// 不劫持 console.error，不修改全局 console。

import type { Plugin } from "obsidian";

import { errorReporter } from "./reporter";

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}

/** 判断栈/文件名是否归属本插件。 */
export function isOwnScript(plugin: Plugin, value: string): boolean {
	if (!value) return false;
	const target = normalizePath(value);
	const dir = plugin.manifest.dir ? normalizePath(plugin.manifest.dir) : "";
	if (dir && target.includes(dir)) return true;
	return target.includes(`${plugin.manifest.id}/main.js`);
}

/** 安装全局钩子；插件卸载时由 registerDomEvent 自动移除。 */
export function installGlobalCapture(plugin: Plugin): void {
	plugin.registerDomEvent(window, "error", (event) => {
		// 资源加载失败（img/script）没有 error 对象，不属于脚本异常。
		if (typeof HTMLElement !== "undefined" && event.target instanceof HTMLElement) return;
		const stack = event.error instanceof Error ? event.error.stack ?? "" : "";
		if (!isOwnScript(plugin, event.filename ?? "") && !isOwnScript(plugin, stack)) return;
		const error = event.error instanceof Error ? event.error : new Error(event.message || "unknown error");
		errorReporter.capture("unknown", error);
	});

	plugin.registerDomEvent(window, "unhandledrejection", (event) => {
		const reason: unknown = event.reason;
		// 只有带 stack 的 rejection 才能确认归属本插件；字符串/对象 reason 一律丢弃，
		// 避免把 Obsidian 或其他插件的内容带进来。
		const stack = reason instanceof Error ? reason.stack ?? "" : "";
		if (!stack || !isOwnScript(plugin, stack)) return;
		errorReporter.capture("unknown", reason);
	});
}

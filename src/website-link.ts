// 官网外跳统一入口：已登录时先取一次性登录票据，再放入 URL fragment；
// 未登录、取票失败或非官网地址时保持普通外跳，不阻塞用户。
import { debugLog } from "./debug-log";
import { openExternal } from "./external-link";
import type PickpenPlugin from "./index";
import { errorCode } from "./remote-connect";
import { BASE_URL } from "./types";

export const LOGIN_TICKET_PARAM = "pickpen_ticket";
export const LOGIN_TICKET_TIMEOUT_MS = 2_000;

/**
 * 判断是否为 Pickpen 官网地址：
 * - 生产/测试：https 的 pickpen.net 子域（排除 API 域名）；
 * - 本地联调：与 API 同主机的 http 地址（含 loopback 与局域网 IP）。
 */
export function isWebsiteURL(raw: string, baseUrl = BASE_URL): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return false;
	const host = url.hostname.toLowerCase();
	if (host === "pickpen.net" || host.endsWith(".pickpen.net")) {
		if (url.protocol !== "https:") return false;
		// API 域名不是官网页面，避免把票据带到接口地址
		return !host.startsWith("api.") && !host.startsWith("api-");
	}
	if (url.protocol !== "http:") return false;
	// 本地联调：只有后端也走 http 且与官网同主机时才放行，避免信任任意 http 地址
	try {
		const base = new URL(baseUrl);
		if (base.protocol !== "http:") return false;
		const baseHost = base.hostname.toLowerCase();
		return host === baseHost || (isLoopbackHost(host) && isLoopbackHost(baseHost));
	} catch {
		return false;
	}
}

function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** 把票据追加到 fragment，保留原有 query 与锚点，并移除重复票据参数。 */
export function withLoginTicket(raw: string, ticket: string): string {
	const url = new URL(raw);
	const parts = url.hash
		.replace(/^#/, "")
		.split("&")
		.filter(Boolean)
		.filter((part) => !part.startsWith(`${LOGIN_TICKET_PARAM}=`));
	parts.push(`${LOGIN_TICKET_PARAM}=${encodeURIComponent(ticket)}`);
	url.hash = parts.join("&");
	return url.toString();
}

/** 已登录时向服务端申请一次性票据；任何失败都返回 undefined，由调用方普通跳转。 */
export async function requestLoginTicket(
	plugin: PickpenPlugin,
	timeoutMs = LOGIN_TICKET_TIMEOUT_MS,
): Promise<string | undefined> {
	if (!plugin.auth.isLoggedIn()) return undefined;
	try {
		const reply = await plugin.client.userClient.createWebLoginTicket({}, { timeoutMs });
		return reply.ticket || undefined;
	} catch (error) {
		// 只记录业务码，不记录 URL 或票据
		debugLog.warn(`[pickpen] 官网登录票据获取失败，错误码：${errorCode(error) ?? "unknown"}`);
		return undefined;
	}
}

/** 打开官网；非官网地址、未登录或取票失败时退化为普通外跳。 */
export async function openWebsite(raw: string, plugin: PickpenPlugin): Promise<void> {
	if (!isWebsiteURL(raw)) {
		openExternal(raw);
		return;
	}
	let target = raw;
	try {
		const ticket = await requestLoginTicket(plugin);
		if (ticket) target = withLoginTicket(raw, ticket);
	} catch {
		target = raw;
	}
	openExternal(target);
}

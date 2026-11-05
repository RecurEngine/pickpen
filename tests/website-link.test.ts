import { beforeEach, describe, expect, it, vi } from "vitest";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("../src/external-link", () => ({ openExternal }));

import type PickpenPlugin from "../src/index";
import { mobileCheckoutUrl, resolveCheckoutURL } from "../src/mobile-subscription-view";
import {
	LOGIN_TICKET_PARAM,
	isWebsiteURL,
	openWebsite,
	requestLoginTicket,
	withLoginTicket,
} from "../src/website-link";

function pluginWithTicket(
	create: () => Promise<{ ticket: string }>,
	loggedIn = true,
): PickpenPlugin {
	return {
		auth: { isLoggedIn: () => loggedIn },
		client: { userClient: { createWebLoginTicket: vi.fn(create) } },
	} as unknown as PickpenPlugin;
}

beforeEach(() => {
	openExternal.mockReset();
});

describe("官网地址判定", () => {
	it("接受官网域名与本地同主机官网", () => {
		expect(isWebsiteURL("https://www.pickpen.net/checkout")).toBe(true);
		expect(isWebsiteURL("https://pickpen.net/pricing")).toBe(true);
		expect(isWebsiteURL("https://sub.pickpen.net/pricing")).toBe(true);
		expect(isWebsiteURL("http://127.0.0.1:5173/checkout", "http://127.0.0.1:8080/api")).toBe(true);
		expect(isWebsiteURL("http://localhost:5173/checkout", "http://127.0.0.1:8080/api")).toBe(true);
		expect(isWebsiteURL("http://192.168.1.5:5173/checkout", "http://192.168.1.5:8080/api")).toBe(true);
	});

	it("拒绝 API 域名、仿冒域名与非 HTTP 协议", () => {
		expect(isWebsiteURL("https://api.pickpen.net/api")).toBe(false);
		expect(isWebsiteURL("https://api-foo.pickpen.net/api")).toBe(false);
		expect(isWebsiteURL("https://www.pickpen.net.evil.com/checkout")).toBe(false);
		expect(isWebsiteURL("https://www.pickpen.net@evil.com/checkout")).toBe(false);
		expect(isWebsiteURL("http://www.pickpen.net/checkout")).toBe(false);
		expect(isWebsiteURL("https://rrecurengine.com/images/pickpen-contact.jpg")).toBe(false);
		expect(isWebsiteURL("mailto:pickpen@rrecurengine.com")).toBe(false);
		expect(isWebsiteURL("obsidian://show-plugin")).toBe(false);
		expect(isWebsiteURL("http://127.0.0.1:5173/checkout", "https://api.pickpen.net/api")).toBe(false);
		expect(isWebsiteURL("http://192.168.1.5:5173/checkout", "https://api.example.com/api")).toBe(false);
	});
});

describe("后端下发的收银台地址", () => {
	it("只接受官网地址", () => {
		expect(resolveCheckoutURL("https://www.pickpen.net/checkout")).toBe("https://www.pickpen.net/checkout");
		expect(resolveCheckoutURL("")).toBeUndefined();
		expect(resolveCheckoutURL("javascript:alert(1)")).toBeUndefined();
		expect(resolveCheckoutURL("https://evil.com/checkout")).toBeUndefined();
	});

	it("追加移动端 entry 参数并保留原有 query", () => {
		expect(mobileCheckoutUrl("https://www.pickpen.net/checkout?from=plugin")).toBe(
			"https://www.pickpen.net/checkout?from=plugin&entry=obsidian-mobile",
		);
	});
});

describe("票据拼接", () => {
	it("保留 query 并追加到 fragment", () => {
		expect(withLoginTicket("https://www.pickpen.net/checkout?entry=obsidian-mobile", "ticket-1")).toBe(
			`https://www.pickpen.net/checkout?entry=obsidian-mobile#${LOGIN_TICKET_PARAM}=ticket-1`,
		);
	});

	it("保留已有锚点并替换重复票据", () => {
		const first = withLoginTicket("https://www.pickpen.net/pricing#plans", "ticket-1");
		expect(first).toBe(`https://www.pickpen.net/pricing#plans&${LOGIN_TICKET_PARAM}=ticket-1`);
		expect(withLoginTicket(first, "ticket-2")).toBe(
			`https://www.pickpen.net/pricing#plans&${LOGIN_TICKET_PARAM}=ticket-2`,
		);
	});
});

describe("票据申请", () => {
	it("未登录不发起请求", async () => {
		const plugin = pluginWithTicket(async () => ({ ticket: "ticket-1" }), false);
		await expect(requestLoginTicket(plugin)).resolves.toBeUndefined();
		expect(plugin.client.userClient.createWebLoginTicket).not.toHaveBeenCalled();
	});

	it("成功返回票据", async () => {
		const plugin = pluginWithTicket(async () => ({ ticket: "ticket-1" }));
		await expect(requestLoginTicket(plugin)).resolves.toBe("ticket-1");
		expect(plugin.client.userClient.createWebLoginTicket).toHaveBeenCalledWith({}, { timeoutMs: 2000 });
	});

	it("空票据或请求失败返回 undefined", async () => {
		const empty = pluginWithTicket(async () => ({ ticket: "" }));
		await expect(requestLoginTicket(empty)).resolves.toBeUndefined();

		const failed = pluginWithTicket(async () => {
			throw new Error("network down");
		});
		await expect(requestLoginTicket(failed)).resolves.toBeUndefined();
	});
});

describe("官网外跳", () => {
	it("非官网地址直接打开原 URL", async () => {
		const plugin = pluginWithTicket(async () => ({ ticket: "ticket-1" }));
		await openWebsite("https://rrecurengine.com/help", plugin);
		expect(openExternal).toHaveBeenCalledTimes(1);
		expect(openExternal).toHaveBeenCalledWith("https://rrecurengine.com/help");
		expect(plugin.client.userClient.createWebLoginTicket).not.toHaveBeenCalled();
	});

	it("未登录时普通跳转", async () => {
		const plugin = pluginWithTicket(async () => ({ ticket: "ticket-1" }), false);
		await openWebsite("https://www.pickpen.net/checkout?entry=obsidian-mobile", plugin);
		expect(openExternal).toHaveBeenCalledWith("https://www.pickpen.net/checkout?entry=obsidian-mobile");
	});

	it("已登录时携带票据跳转", async () => {
		const plugin = pluginWithTicket(async () => ({ ticket: "ticket-1" }));
		await openWebsite("https://www.pickpen.net/checkout?entry=obsidian-mobile", plugin);
		expect(openExternal).toHaveBeenCalledWith(
			`https://www.pickpen.net/checkout?entry=obsidian-mobile#${LOGIN_TICKET_PARAM}=ticket-1`,
		);
	});

	it("取票失败时降级为普通跳转", async () => {
		const plugin = pluginWithTicket(async () => {
			throw new Error("network down");
		});
		await openWebsite("https://www.pickpen.net/checkout?entry=obsidian-mobile", plugin);
		expect(openExternal).toHaveBeenCalledTimes(1);
		expect(openExternal).toHaveBeenCalledWith("https://www.pickpen.net/checkout?entry=obsidian-mobile");
	});
});

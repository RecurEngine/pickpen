import { describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { AuthManager } from "../src/auth";
import { SyncService } from "../src/gen/proto/sync/sync.ext_pb";
import { UserService } from "../src/gen/proto/user/user.ext_pb";
import {
	createAuthInterceptor,
	ErrCode,
	getClientOS,
	type RemoteClient,
	type RemoteConfig,
} from "../src/remote-connect";
import type { PluginSettings } from "../src/types";

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
	return {
		vaultId: "1",
		vaultName: "vault",
		email: "user@example.com",
		userId: "61",
		accessToken: "old-access",
		accessExpiresAtMs: Date.now() + 60 * 60 * 1000,
		refreshToken: "old-refresh",
		refreshExpiresAtMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
		deviceId: "dev-1",
		extraExcludes: [],
		debugLog: false,
		persist: vi.fn(async () => {}),
		...overrides,
	};
}

function clientWithRefresh(refreshToken: (...args: unknown[]) => Promise<unknown>): RemoteClient {
	return {
		userClient: { refreshToken },
	} as unknown as RemoteClient;
}

function request(method: unknown, authorization = "Bearer stale") {
	const header = new Headers();
	if (authorization) header.set("Authorization", authorization);
	return {
		stream: false,
		method,
		header,
		requestMethod: "POST",
		url: "https://example.test/rpc",
	};
}

function invokeInterceptor(
	getConfig: () => RemoteConfig,
	next: (req: ReturnType<typeof request>) => Promise<unknown>,
	req: ReturnType<typeof request>,
) {
	const invoke = createAuthInterceptor(getConfig)(next as never);
	return invoke(req as never);
}

describe("AuthManager refresh 去重", () => {
	it("在 refresh RPC 启动前发布在途 Promise，阻止同步重入", async () => {
		const state = settings();
		let manager: AuthManager;
		let nested: Promise<boolean> | undefined;
		let outer: Promise<boolean>;
		const refreshToken = vi.fn(async () => {
			nested = manager.refresh();
			return {
				accessToken: "new-access",
				accessExpiresAtMs: BigInt(Date.now() + 2 * 60 * 60 * 1000),
				refreshToken: "new-refresh",
				refreshExpiresAtMs: BigInt(Date.now() + 30 * 24 * 60 * 60 * 1000),
			};
		});
		manager = new AuthManager(state, clientWithRefresh(refreshToken), () => {});

		outer = manager.refresh();
		expect(await outer).toBe(true);
		expect(nested).toBe(outer);
		expect(refreshToken).toHaveBeenCalledTimes(1);
	});

	it("并发 refresh 共享一次网络请求", async () => {
		const state = settings();
		const refreshToken = vi.fn(async () => {
			await Promise.resolve();
			return {
				accessToken: "new-access",
				accessExpiresAtMs: 2n,
				refreshToken: "new-refresh",
				refreshExpiresAtMs: 3n,
			};
		});
		const manager = new AuthManager(state, clientWithRefresh(refreshToken), () => {});

		expect(await Promise.all([manager.refresh(), manager.refresh(), manager.refresh()])).toEqual([true, true, true]);
		expect(refreshToken).toHaveBeenCalledTimes(1);
		expect(state.accessToken).toBe("new-access");
		expect(state.refreshToken).toBe("new-refresh");
	});

	it("refresh token 返回 11002 时清空登录态", async () => {
		const state = settings();
		const refreshToken = vi.fn(async () => {
			throw { code: ErrCode.InvalidOrMissingCredentials };
		});
		const manager = new AuthManager(state, clientWithRefresh(refreshToken), () => {});

		expect(await manager.refresh()).toBe(false);
		expect(refreshToken).toHaveBeenCalledTimes(1);
		expect(state.accessToken).toBe("");
		expect(state.refreshToken).toBe("");
		expect(state.userId).toBe("");
	});
});

describe("认证 interceptor 刷新状态机", () => {
	it("根据 Obsidian 运行平台生成操作系统标识", () => {
		const original = { ...Platform };
		try {
			Object.assign(Platform, { isIosApp: false, isAndroidApp: false, isMacOS: false, isWin: true, isLinux: false });
			expect(getClientOS()).toBe("windows");
			Object.assign(Platform, { isIosApp: true, isWin: false });
			expect(getClientOS()).toBe("ios");
		} finally {
			Object.assign(Platform, original);
		}
	});

	it("并发过期业务请求只刷新一次并全部使用新 access token", async () => {
		const state = settings({ accessExpiresAtMs: Date.now() - 1 });
		const refreshToken = vi.fn(async () => ({
			accessToken: "new-access",
			accessExpiresAtMs: BigInt(Date.now() + 2 * 60 * 60 * 1000),
			refreshToken: "new-refresh",
			refreshExpiresAtMs: BigInt(Date.now() + 30 * 24 * 60 * 60 * 1000),
		}));
		const manager = new AuthManager(state, clientWithRefresh(refreshToken), () => {});
		const getConfig = (): RemoteConfig => ({
			baseUrl: "https://example.test/api",
			pluginVersion: "0.1.0",
			accessToken: state.accessToken,
			accessExpiresAtMs: state.accessExpiresAtMs,
			vaultId: state.vaultId,
			onUnauthenticated: () => manager.refresh(),
		});
		const seenAuth: string[] = [];
		const next = vi.fn(async (req: ReturnType<typeof request>) => {
			seenAuth.push(req.header.get("Authorization") ?? "");
			return { ok: true };
		});

		await Promise.all(
			Array.from({ length: 4 }, () =>
				invokeInterceptor(getConfig, next, request(SyncService.method.getVaultHead)),
			),
		);

		expect(refreshToken).toHaveBeenCalledTimes(1);
		expect(next).toHaveBeenCalledTimes(4);
		expect(seenAuth).toEqual(Array(4).fill("Bearer new-access"));
	});

	it.each([
		UserService.method.sendCode,
		UserService.method.login,
		UserService.method.refreshToken,
	])("公开认证 RPC %s 不注入 access token且不触发刷新", async (method) => {
		const onUnauthenticated = vi.fn(async () => true);
		const cfg: RemoteConfig = {
			baseUrl: "https://example.test/api",
			pluginVersion: "0.1.0",
			accessToken: "expired-access",
			accessExpiresAtMs: Date.now() - 1,
			vaultId: "1",
			onUnauthenticated,
		};
		const failure = { code: ErrCode.InvalidOrMissingCredentials };
		const next = vi.fn(async (req: ReturnType<typeof request>) => {
			expect(req.header.get("Authorization")).toBeNull();
			expect(req.header.get("Plugin-Version")).toBe("0.1.0");
			expect(req.header.get("Client-Platform")).toBe("plugin");
			expect(req.header.get("Client-OS")).toBe("macos");
			throw failure;
		});

		await expect(invokeInterceptor(() => cfg, next, request(method))).rejects.toBe(failure);
		expect(next).toHaveBeenCalledTimes(1);
		expect(onUnauthenticated).not.toHaveBeenCalled();
	});

	it("普通请求收到 11002 后刷新一次并使用新 token 重试", async () => {
		let accessToken = "old-access";
		const onUnauthenticated = vi.fn(async () => {
			accessToken = "new-access";
			return true;
		});
		const getConfig = (): RemoteConfig => ({
			baseUrl: "https://example.test/api",
			pluginVersion: "0.1.0",
			accessToken,
			accessExpiresAtMs: Date.now() + 60 * 60 * 1000,
			vaultId: "1",
			onUnauthenticated,
		});
		const seenAuth: string[] = [];
		const next = vi.fn(async (req: ReturnType<typeof request>) => {
			seenAuth.push(req.header.get("Authorization") ?? "");
			if (seenAuth.length === 1) throw { code: ErrCode.InvalidOrMissingCredentials };
			return { ok: true };
		});

		await invokeInterceptor(getConfig, next, request(SyncService.method.getVaultHead));
		expect(onUnauthenticated).toHaveBeenCalledTimes(1);
		expect(seenAuth).toEqual(["Bearer old-access", "Bearer new-access"]);
	});

	it("预刷新失败后不因业务请求的 11002 再次刷新", async () => {
		const failure = { code: ErrCode.InvalidOrMissingCredentials };
		const onUnauthenticated = vi.fn(async () => false);
		const cfg: RemoteConfig = {
			baseUrl: "https://example.test/api",
			pluginVersion: "0.1.0",
			accessToken: "expired-access",
			accessExpiresAtMs: Date.now() - 1,
			vaultId: "1",
			onUnauthenticated,
		};
		const next = vi.fn(async () => {
			throw failure;
		});

		await expect(
			invokeInterceptor(() => cfg, next, request(SyncService.method.getVaultHead)),
		).rejects.toBe(failure);
		expect(onUnauthenticated).toHaveBeenCalledTimes(1);
		expect(next).toHaveBeenCalledTimes(1);
	});
});

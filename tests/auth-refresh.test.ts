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
import type { SessionFields } from "../src/session-store";
import { defaultSelectiveSettings } from "../src/sync/selective";
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
		selective: defaultSelectiveSettings(),
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

/** 设备本地会话记录桩：read 返回当前记录（可模拟「另一个实例刚写入新 token」） */
function deviceSession(overrides: Partial<SessionFields> = {}) {
	let state: SessionFields = {
		email: "user@example.com",
		userId: "61",
		accessToken: "old-access",
		accessExpiresAtMs: 0,
		refreshToken: "old-refresh",
		refreshExpiresAtMs: 0,
		deviceId: "dev-1",
		...overrides,
	};
	return {
		read: () => ({ ...state }),
		write: (patch: Partial<SessionFields>) => (state = { ...state, ...patch }),
	};
}

/** 装配 AuthManager：写回调空实现（会话落盘由 SessionStore 单测覆盖），读回调接设备记录桩 */
function managerWith(
	state: PluginSettings,
	refreshToken: (...args: unknown[]) => Promise<unknown>,
	device = deviceSession(),
): AuthManager {
	return new AuthManager(state, clientWithRefresh(refreshToken), () => {}, () => device.read());
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
		manager = managerWith(state, refreshToken);

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
		const manager = managerWith(state, refreshToken);

		expect(await Promise.all([manager.refresh(), manager.refresh(), manager.refresh()])).toEqual([true, true, true]);
		expect(refreshToken).toHaveBeenCalledTimes(1);
		expect(state.accessToken).toBe("new-access");
		expect(state.refreshToken).toBe("new-refresh");
	});

	it("refresh token 返回 11002 且本机记录仍是同一把 → 会话确实失效，清空登录态", async () => {
		const state = settings();
		const refreshToken = vi.fn(async () => {
			throw { code: ErrCode.InvalidOrMissingCredentials };
		});
		const manager = managerWith(state, refreshToken);

		expect(await manager.refresh()).toBe(false);
		expect(refreshToken).toHaveBeenCalledTimes(1);
		expect(state.accessToken).toBe("");
		expect(state.refreshToken).toBe("");
		expect(state.userId).toBe("");
	});

	it("11002 但本机记录已被另一个实例轮换 → 改用记录里的新 token 重试一次，不登出", async () => {
		const state = settings();
		// 插件重载窗口：另一个实例已经刷新过，本机记录里是新的一把，而我手里提交的是旧的
		const device = deviceSession({ accessToken: "peer-access", refreshToken: "peer-refresh", userId: "61" });
		const seen: string[] = [];
		const refreshToken = vi.fn(async (raw: unknown) => {
			const { refreshToken: presented } = raw as { refreshToken: string };
			seen.push(presented);
			if (presented === "old-refresh") throw { code: ErrCode.InvalidOrMissingCredentials };
			return {
				accessToken: "healed-access",
				accessExpiresAtMs: 11n,
				refreshToken: "healed-refresh",
				refreshExpiresAtMs: 12n,
			};
		});
		const manager = managerWith(state, refreshToken, device);

		expect(await manager.refresh()).toBe(true);
		expect(seen).toEqual(["old-refresh", "peer-refresh"]);
		expect(state.accessToken).toBe("healed-access");
		expect(state.refreshToken).toBe("healed-refresh");
		expect(state.userId).toBe("61"); // 未被登出清空
	});

	it("本机记录属于另一个账号时不采用（只认同一 userId）", async () => {
		const state = settings();
		const device = deviceSession({ refreshToken: "other-account-refresh", userId: "999" });
		const refreshToken = vi.fn(async () => {
			throw { code: ErrCode.InvalidOrMissingCredentials };
		});
		const manager = managerWith(state, refreshToken, device);

		expect(await manager.refresh()).toBe(false);
		expect(refreshToken).toHaveBeenCalledTimes(1); // 没有拿别的账号的 token 重试
		expect(state.accessToken).toBe("");
	});

	it("已卸载的实例不再刷新，也不清空与新实例共享的会话", async () => {
		const state = settings();
		const refreshToken = vi.fn(async () => {
			throw { code: ErrCode.InvalidOrMissingCredentials };
		});
		const manager = managerWith(state, refreshToken);
		manager.dispose();

		expect(await manager.refresh()).toBe(false);
		expect(refreshToken).not.toHaveBeenCalled();
		expect(state.accessToken).toBe("old-access");

		await manager.logout();
		expect(state.accessToken).toBe("old-access"); // 旧实例无权清掉新实例正在用的会话
	});

	it("在途刷新期间被卸载：完成后不因 11002 清空会话", async () => {
		const state = settings();
		let release = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const refreshToken = vi.fn(async () => {
			await gate;
			throw { code: ErrCode.InvalidOrMissingCredentials };
		});
		const manager = managerWith(state, refreshToken);

		const inflight = manager.refresh();
		manager.dispose(); // 刷新已在途时插件被卸载
		release();

		expect(await inflight).toBe(false);
		expect(state.accessToken).toBe("old-access");
		expect(state.refreshToken).toBe("old-refresh");
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
		const manager = managerWith(state, refreshToken);
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
	])("公开 RPC %s 不注入 access token且不触发刷新", async (method) => {
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

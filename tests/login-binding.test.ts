// 登录绑定状态机的集成单测：统一解绑、登录后归属核验、afterLogin 分支。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vaultKeys } from "../src/crypto/vault-key-store";
import PickpenPlugin from "../src/index";
import { PAUSED_NO_VAULT, syncState } from "../src/sync-state";
import type { LoginBindingDecision } from "../src/vault-binding";
import type { VaultInfo } from "../src/types";

type HostSettings = {
	email: string;
	vaultId: string;
	vaultName: string;
	accessToken: string;
	vaultOwner?: { vaultId: string; email: string };
};

interface Host {
	settings: HostSettings;
	accountBinding: { email: string; vaultId: string } | null;
	saveSettings: () => Promise<void>;
	handleStorageLimitState: () => void;
	[key: string]: unknown;
}

function baseHost(settings: Partial<HostSettings>, overrides: Record<string, unknown> = {}): Host {
	return {
		settings: {
			email: "b@example.com",
			vaultId: "76",
			vaultName: "兼收并蓄",
			accessToken: "token",
			...settings,
		},
		accountBinding: null,
		saveSettings: async () => {},
		handleStorageLimitState: () => {},
		...overrides,
	};
}

function callUnbind(host: Host): Promise<void> {
	return PickpenPlugin.prototype.unbindVault.call(host as unknown as PickpenPlugin);
}

function callResolve(
	host: Host,
	listVaults: () => Promise<readonly VaultInfo[]>,
): Promise<LoginBindingDecision> {
	const proto = PickpenPlugin.prototype as unknown as {
		resolveLoginBinding: (list: () => Promise<readonly VaultInfo[]>) => Promise<LoginBindingDecision>;
	};
	return proto.resolveLoginBinding.call(host as unknown as PickpenPlugin, listVaults);
}

function callAfterLogin(
	host: Record<string, unknown>,
	opener: (app: unknown, plugin: unknown, onChange?: () => void) => void,
): Promise<void> {
	return PickpenPlugin.prototype.afterLogin.call(host as unknown as PickpenPlugin, undefined, opener as never);
}

beforeEach(() => {
	syncState.update({ pausedReason: "", lastError: "", sessionRunning: false, storageLimitExceeded: false });
});

afterEach(() => {
	vi.restoreAllMocks();
	syncState.update({ pausedReason: "", lastError: "", sessionRunning: false, storageLimitExceeded: false });
});

describe("unbindVault", () => {
	it("清空绑定指针、归属与会话记忆，并重置仓库密钥", async () => {
		const reset = vi.spyOn(vaultKeys, "reset");
		const host = baseHost({ vaultOwner: { vaultId: "76", email: "a@example.com" } }, {
			accountBinding: { email: "a@example.com", vaultId: "76" },
		});
		await callUnbind(host);
		expect(host.settings.vaultId).toBe("");
		expect(host.settings.vaultName).toBe("");
		expect(host.settings.vaultOwner).toBeUndefined();
		expect(host.accountBinding).toBeNull();
		expect(reset).toHaveBeenCalled();
	});

	it("落盘失败不抛出，内存状态仍已清空", async () => {
		const host = baseHost({ vaultOwner: { vaultId: "76", email: "a@example.com" } }, {
			accountBinding: { email: "a@example.com", vaultId: "76" },
			saveSettings: async () => {
				throw new Error("disk full");
			},
		});
		await expect(callUnbind(host)).resolves.toBeUndefined();
		expect(host.settings.vaultId).toBe("");
		expect(host.accountBinding).toBeNull();
	});

	it("不设置暂停原因（暂停语义由调用方决定）", async () => {
		syncState.update({ pausedReason: PAUSED_NO_VAULT });
		await callUnbind(baseHost({}));
		expect(syncState.pausedReason).toBe(PAUSED_NO_VAULT);
	});
});

describe("resolveLoginBinding", () => {
	it("owner 匹配：直接沿用，不请求服务端", async () => {
		const list = vi.fn(async () => {
			throw new Error("不应调用");
		});
		const host = baseHost({ vaultOwner: { vaultId: "76", email: "B@Example.com" } });
		await expect(callResolve(host, list)).resolves.toEqual({
			kind: "adopt",
			writeOwner: false,
			name: "兼收并蓄",
		});
		expect(list).not.toHaveBeenCalled();
	});

	it("owner 缺失 + 列表命中：补写归属并沿用列表名", async () => {
		const host = baseHost({ vaultName: "旧名" });
		await expect(
			callResolve(host, async () => [{ vaultId: "76", name: "兼收并蓄" } as VaultInfo]),
		).resolves.toEqual({ kind: "adopt", writeOwner: true, name: "兼收并蓄" });
		expect(host.settings.vaultOwner).toEqual({ vaultId: "76", email: "b@example.com" });
		expect(host.accountBinding).toEqual({ email: "b@example.com", vaultId: "76" });
		expect(host.settings.vaultName).toBe("兼收并蓄");
	});

	it("owner 属于 A + 当前 B + 列表未命中：解绑重选", async () => {
		const host = baseHost({ vaultOwner: { vaultId: "76", email: "a@example.com" } });
		await expect(callResolve(host, async () => [])).resolves.toEqual({ kind: "select", clear: true });
	});

	it("列表失败 + owner 缺失 + 会话记忆匹配：沿用并补归属", async () => {
		const host = baseHost({}, { accountBinding: { email: "b@example.com", vaultId: "76" } });
		await expect(
			callResolve(host, async () => {
				throw new Error("offline");
			}),
		).resolves.toEqual({ kind: "adopt", writeOwner: true, name: "兼收并蓄" });
	});

	it("列表失败 + owner 属于其他账号 + 会话记忆匹配：owner 优先，解绑重选且不抛出", async () => {
		const host = baseHost({ vaultOwner: { vaultId: "76", email: "a@example.com" } }, {
			accountBinding: { email: "b@example.com", vaultId: "76" },
		});
		await expect(
			callResolve(host, async () => {
				throw new Error("offline");
			}),
		).resolves.toEqual({ kind: "select", clear: true });
	});
});

describe("afterLogin", () => {
	function loginHost(decision: LoginBindingDecision, overrides: Record<string, unknown> = {}) {
		const unbind = vi.fn(async () => {});
		const pollNow = vi.fn(async () => {});
		const host = {
			...baseHost({}),
			app: {},
			settingTab: { refreshBenefitAvailability: () => {} },
			resolveLoginBinding: async () => decision,
			unbindVault: unbind,
			pauseSync: PickpenPlugin.prototype.pauseSync,
			resumeSync: PickpenPlugin.prototype.resumeSync,
			poller: { pollNow },
			...overrides,
		};
		return { host, unbind, pollNow };
	}

	it("select + clear：解除残留绑定、暂停并打开仓库管理", async () => {
		const { host, unbind } = loginHost({ kind: "select", clear: true });
		const opener = vi.fn();
		await callAfterLogin(host, opener);
		expect(unbind).toHaveBeenCalledTimes(1);
		expect(syncState.pausedReason).toBe(PAUSED_NO_VAULT);
		expect(opener).toHaveBeenCalledTimes(1);
	});

	it("select + 未绑定：不调用解绑，仍然暂停并打开仓库管理", async () => {
		const { host, unbind } = loginHost({ kind: "select", clear: false });
		const opener = vi.fn();
		await callAfterLogin(host, opener);
		expect(unbind).not.toHaveBeenCalled();
		expect(syncState.pausedReason).toBe(PAUSED_NO_VAULT);
		expect(opener).toHaveBeenCalledTimes(1);
	});

	it("adopt：恢复同步并立即轮询，不打开仓库管理", async () => {
		const { host, pollNow } = loginHost({ kind: "adopt", writeOwner: false, name: "兼收并蓄" });
		const opener = vi.fn();
		await callAfterLogin(host, opener);
		expect(syncState.pausedReason).toBe("");
		expect(pollNow).toHaveBeenCalledTimes(1);
		expect(opener).not.toHaveBeenCalled();
	});
});

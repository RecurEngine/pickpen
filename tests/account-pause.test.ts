// 「未登录 / 请选择要绑定的仓库」这类由配置状态派生的暂停必须能自愈。
//
// 事故现场（移动端真机）：创建加密仓库并绑定时，saveSettings 的 await 挂住（安卓 WebView 被
// 冻结/遮挡导致原生桥回包迟迟不回），而解除暂停的 resumeSync 排在它后面 —— 绑定信息已进内存、
// data.json 也已由原生侧落盘，用户看到的是「已绑定：v」，同步状态却永远停在「已暂停：请选择
// 要绑定的仓库」，并且 pausedReason 把后台轮询一并关掉，此后不再自动拉取远端改动。
//
// 这里锁两件事：① 绑定一进内存就先解除暂停，不等落盘；② 一轮成功同步会清掉过时的派生暂停。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import PickpenPlugin from "../src/index";
import { isAccountPausedReason, PAUSED_BY_LOCK, PAUSED_NO_VAULT, PAUSED_NOT_SIGNED_IN, shouldClearAccountPause, syncState } from "../src/sync-state";

/** 让所有已就绪的微任务与 0ms 定时器先跑完（bindVault 在落盘前有两处 await） */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** bindVault 只用到这些成员；未覆盖到的分支（采纳远端状态/弹解锁窗）在本用例里走不到 */
function fakeHost(overrides: Record<string, unknown> = {}) {
	return {
		settings: { vaultId: "", vaultName: "", email: "user@example.com", accessToken: "token" },
		accountBinding: null as { email: string; vaultId: string } | null,
		baseStore: { reset: () => {}, flush: async () => {} },
		pendingStore: { clear: async () => {} },
		session: { reset: () => {}, requestRun: () => {} },
		handleStorageLimitState: () => {},
		saveSettings: async () => {},
		// 绑定收尾会去取远端加密状态并弹解锁窗：本用例只关心暂停标志，这两步打桩
		adoptVaultState: async () => undefined,
		syncVaultLockState: () => {},
		resumeSync: PickpenPlugin.prototype.resumeSync,
		...overrides,
	};
}

/** 已登录 + 已绑定的宿主（自愈用例的前置状态） */
function boundHost(overrides: Record<string, unknown> = {}) {
	return fakeHost({
		settings: { vaultId: "1058", vaultName: "v", email: "user@example.com", accessToken: "token" },
		...overrides,
	});
}

function callBindVault(host: ReturnType<typeof fakeHost>, vaultId = "1058", name = "v"): Promise<void> {
	return PickpenPlugin.prototype.bindVault.call(host as unknown as PickpenPlugin, vaultId, name);
}

function heal(host: ReturnType<typeof fakeHost>, running: boolean, lastError: string): void {
	const proto = PickpenPlugin.prototype as unknown as { healAccountPause: (r: boolean, e: string) => void };
	proto.healAccountPause.call(host as unknown as PickpenPlugin, running, lastError);
}

beforeEach(() => {
	syncState.update({ pausedReason: "", lastError: "", sessionRunning: false, storageLimitExceeded: false });
});

afterEach(() => {
	syncState.update({ pausedReason: "", lastError: "", sessionRunning: false, storageLimitExceeded: false });
});

describe("绑定与派生暂停", () => {
	it("落盘挂起（原生桥回包丢失）时，绑定也必须已经解除暂停", async () => {
		syncState.update({ pausedReason: PAUSED_NO_VAULT });
		const host = fakeHost({ saveSettings: () => new Promise<void>(() => {}) }); // 永不返回
		void callBindVault(host); // bindVault 会一直挂在落盘上，不 await
		await tick();
		expect(host.settings.vaultId).toBe("1058");
		expect(syncState.pausedReason).toBe("");
	});

	it("落盘抛错时同样先解除暂停（绑定以内存状态为准，不以落盘成功为准）", async () => {
		syncState.update({ pausedReason: PAUSED_NO_VAULT });
		const host = fakeHost({
			saveSettings: async () => {
				throw new Error("disk full");
			},
		});
		await expect(callBindVault(host)).rejects.toThrow("disk full");
		expect(host.settings.vaultId).toBe("1058");
		expect(syncState.pausedReason).toBe("");
	});

	it("正常落盘时行为不变", async () => {
		syncState.update({ pausedReason: PAUSED_NO_VAULT });
		const host = fakeHost();
		await callBindVault(host);
		expect(syncState.pausedReason).toBe("");
	});
});

describe("成功同步自愈派生暂停", () => {
	it("一轮同步成功跑完 ⇒ 清掉「请选择要绑定的仓库」/「未登录」", () => {
		for (const reason of [PAUSED_NO_VAULT, PAUSED_NOT_SIGNED_IN]) {
			syncState.update({ pausedReason: reason });
			heal(boundHost(), false, "");
			expect(syncState.pausedReason).toBe("");
		}
	});

	it("在途、有错误、或登录态/绑定缺失时不动暂停", () => {
		const cases: Array<[string, boolean, string, Record<string, unknown>]> = [
			["同步在途", true, "", {}],
			["本轮有错误", false, "网络失败", {}],
			["未登录（token 为空）", false, "", { settings: { vaultId: "1058", accessToken: "" } }],
			["未绑定（vaultId 为空）", false, "", { settings: { vaultId: "", accessToken: "token" } }],
		];
		for (const [label, running, lastError, overrides] of cases) {
			syncState.update({ pausedReason: PAUSED_NO_VAULT });
			heal(boundHost(overrides), running, lastError);
			expect(syncState.pausedReason, label).toBe(PAUSED_NO_VAULT);
		}
	});

	it("不越权清别的原因（解锁/仓库管理操作中的暂停不归它管）", () => {
		syncState.update({ pausedReason: PAUSED_BY_LOCK });
		heal(boundHost(), false, "");
		expect(syncState.pausedReason).toBe(PAUSED_BY_LOCK);
		expect(isAccountPausedReason(PAUSED_BY_LOCK)).toBe(false);
	});

	it("判定表：只有「已结束 + 无错误 + 有 token + 有绑定 + 派生原因」才清", () => {
		const base = { running: false, lastError: "", accessToken: "t", vaultId: "1058", pausedReason: PAUSED_NO_VAULT };
		expect(shouldClearAccountPause(base)).toBe(true);
		expect(shouldClearAccountPause({ ...base, pausedReason: PAUSED_NOT_SIGNED_IN })).toBe(true);
		expect(shouldClearAccountPause({ ...base, running: true })).toBe(false);
		expect(shouldClearAccountPause({ ...base, lastError: "x" })).toBe(false);
		expect(shouldClearAccountPause({ ...base, accessToken: "" })).toBe(false);
		expect(shouldClearAccountPause({ ...base, vaultId: "" })).toBe(false);
		expect(shouldClearAccountPause({ ...base, pausedReason: "" })).toBe(false);
		expect(shouldClearAccountPause({ ...base, pausedReason: PAUSED_BY_LOCK })).toBe(false);
	});
});

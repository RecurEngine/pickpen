// SessionStore 单测：per-vault key 隔离、存取往返、ensureDeviceId、JSON 损坏自愈、会话源语义。

import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type PluginSettings } from "../src/types";
import { sessionKeyForScope, SessionStore, type KeyValueStore } from "../src/session-store";

// memoryKV 内存键值实现（node 无 localStorage）
function memoryKV(): KeyValueStore & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v),
		removeItem: (k) => void data.delete(k),
	};
}

// makeSettings 构造一个带会话字段的镜像 settings
function makeSettings(over: Partial<PluginSettings> = {}): PluginSettings {
	return { ...DEFAULT_SETTINGS, ...over };
}

describe("SessionStore 基本存取", () => {
	it("captureFrom 持久化，新实例 load 后可见（往返）", () => {
		const kv = memoryKV();
		const store = new SessionStore(kv, "scopeA");
		store.load();
		const s = makeSettings({
			email: "a@x.com",
			userId: "7",
			accessToken: "tok",
			accessExpiresAtMs: 111,
			refreshToken: "ref",
			refreshExpiresAtMs: 222,
			deviceId: "dev-A",
		});
		store.captureFrom(s);
		expect(store.hasToken()).toBe(true);

		// 模拟重启：同一 key 新实例
		const again = new SessionStore(kv, "scopeA");
		again.load();
		expect(again.hasToken()).toBe(true);
		const out = makeSettings();
		again.applyTo(out);
		expect(out.email).toBe("a@x.com");
		expect(out.deviceId).toBe("dev-A");
		expect(out.refreshToken).toBe("ref");
	});

	it("per-vault key 隔离：不同 scope 互不可见", () => {
		const kv = memoryKV();
		const a = new SessionStore(kv, "scopeA");
		a.load();
		a.captureFrom(makeSettings({ deviceId: "dev-A", accessToken: "tA", email: "a@x.com" }));

		const b = new SessionStore(kv, "scopeB");
		b.load();
		expect(b.hasToken()).toBe(false);
		expect(b.deviceId).toBe("");
		// key 前缀相同但 scope 后缀不同
		expect(sessionKeyForScope("scopeA")).not.toBe(sessionKeyForScope("scopeB"));
		expect(sessionKeyForScope("scopeA")).toContain("pickpen:session:v1:");
	});

	it("ensureDeviceId 只生成一次并持久化", () => {
		const kv = memoryKV();
		const store = new SessionStore(kv, "scopeA");
		store.load();
		const d1 = store.ensureDeviceId();
		expect(d1).toMatch(/^[0-9a-f-]{36}$/);
		expect(store.ensureDeviceId()).toBe(d1); // 幂等

		const again = new SessionStore(kv, "scopeA");
		again.load();
		expect(again.deviceId).toBe(d1); // 重启后保持
	});

	it("logout 语义：清 token/userId，保 email+deviceId（模拟 auth.logout 改镜像再 captureFrom）", () => {
		const kv = memoryKV();
		const store = new SessionStore(kv, "scopeA");
		store.load();
		store.captureFrom(
			makeSettings({ email: "a@x.com", userId: "7", accessToken: "t", refreshToken: "r", deviceId: "dev-A" }),
		);
		// 模拟 logout：auth 清 token/userId，保留 email/deviceId
		store.captureFrom(makeSettings({ email: "a@x.com", userId: "", accessToken: "", refreshToken: "", deviceId: "dev-A" }));
		expect(store.hasToken()).toBe(false);
		expect(store.email).toBe("a@x.com");
		expect(store.deviceId).toBe("dev-A");
	});

	it("setEmail / vaultOwner 记忆", () => {
		const kv = memoryKV();
		const store = new SessionStore(kv, "scopeA");
		store.load();
		store.setEmail("pre@x.com");
		expect(store.email).toBe("pre@x.com");
		store.setVaultOwner("3", "a@x.com");
		expect(store.vaultOwner).toEqual({ vaultId: "3", email: "a@x.com" });
		store.clearVaultOwner();
		expect(store.vaultOwner).toBeUndefined();
	});

	it("存储已满提醒日期持久化，并可在容量恢复后清除", () => {
		const kv = memoryKV();
		const store = new SessionStore(kv, "scopeA");
		store.load();
		expect(store.storageLimitAlertActive).toBe(false);

		store.markStorageLimitAlertShown("2026-09-04");
		expect(store.storageLimitAlertDate).toBe("2026-09-04");
		expect(store.storageLimitAlertActive).toBe(true);

		const again = new SessionStore(kv, "scopeA");
		again.load();
		expect(again.storageLimitAlertDate).toBe("2026-09-04");
		again.clearStorageLimitAlert();
		expect(again.storageLimitAlertActive).toBe(false);
	});
});

describe("SessionStore 健壮性", () => {
	it("JSON 损坏自愈为合法空态并清除键", () => {
		const kv = memoryKV();
		kv.setItem(sessionKeyForScope("scopeA"), "not-json{{{");
		const store = new SessionStore(kv, "scopeA");
		store.load();
		expect(store.hasToken()).toBe(false);
		expect(store.deviceId).toBe("");
		expect(kv.getItem(sessionKeyForScope("scopeA"))).toBeNull(); // 已清除
	});

	it("schema 不符视为空态", () => {
		const kv = memoryKV();
		kv.setItem(sessionKeyForScope("scopeA"), JSON.stringify({ schema: 99, deviceId: "dev" }));
		const store = new SessionStore(kv, "scopeA");
		store.load();
		expect(store.hasToken()).toBe(false);
		expect(store.deviceId).toBe("");
	});

	it("localStorage 不可用 → available=false，仅内存可登录", () => {
		const store = new SessionStore(null, "scopeA"); // kv 缺失 → 内部内存兜底
		expect(store.available).toBe(false);
		store.load();
		const d = store.ensureDeviceId();
		expect(d).toMatch(/^[0-9a-f-]{36}$/);
		expect(store.hasToken()).toBe(false);
	});
});

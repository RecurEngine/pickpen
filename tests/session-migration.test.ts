// 迁移判定与 data.json 序列化剔除的单测。

import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type PluginSettings } from "../src/types";
import { planLegacyMigration, SESSION_KEYS, stripSessionKeys } from "../src/session-store";

describe("planLegacyMigration", () => {
	it("localStorage 已有会话 → cleanup（权威，只剔 data.json 残留）", () => {
		expect(planLegacyMigration(true, true)).toBe("cleanup");
		expect(planLegacyMigration(false, true)).toBe("cleanup");
	});
	it("老用户首迁：data.json 有会话且 localStorage 空 → import", () => {
		expect(planLegacyMigration(true, false)).toBe("import");
	});
	it("全新：两端都无 → fresh", () => {
		expect(planLegacyMigration(false, false)).toBe("fresh");
	});
});

describe("stripSessionKeys", () => {
	it("剔除全部会话键与 persist，保留绑定/偏好键", () => {
		const s: PluginSettings = {
			...DEFAULT_SETTINGS,
			vaultId: "3",
			vaultName: "hello",
			extraExcludes: ["private/"],
			debugLog: true,
			email: "a@x.com",
			userId: "7",
			accessToken: "tok",
			accessExpiresAtMs: 1,
			refreshToken: "ref",
			refreshExpiresAtMs: 2,
			deviceId: "dev",
		};
		const stripped = stripSessionKeys(s);
		// 会话键全不在
		for (const k of SESSION_KEYS) {
			expect(k in stripped).toBe(false);
		}
		expect("persist" in stripped).toBe(false);
		// 保留键在
		expect(stripped.vaultId).toBe("3");
		expect(stripped.vaultName).toBe("hello");
		expect(stripped.extraExcludes).toEqual(["private/"]);
		expect(stripped.debugLog).toBe(true);
	});
});

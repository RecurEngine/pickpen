// 版本策略判定：SemVer 解析/比较与「强制 / 软提醒 / 无事」的边界。
import { describe, expect, it } from "vitest";
import {
	compareVersions,
	evaluateVersionPolicy,
	parseVersion,
	shouldNotifyVersion,
	versionModalKey,
} from "../src/version-check";

const policy = (minSupported: string, latest: string) => ({ minSupported, latest });

describe("parseVersion", () => {
	it("解析正式版与预发布版本", () => {
		expect(parseVersion("1.7.0")).toEqual({ major: 1, minor: 7, patch: 0, pre: [] });
		expect(parseVersion(" 1.10.3 ")).toEqual({ major: 1, minor: 10, patch: 3, pre: [] });
		expect(parseVersion("2.0.0-beta.2")?.pre).toEqual(["beta", "2"]);
		expect(parseVersion("2.0.0+build.7")).toEqual({ major: 2, minor: 0, patch: 0, pre: [] });
	});

	it("非法输入返回 null，不抛错", () => {
		for (const value of ["", "1.7", "1.7.0.1", "v1.7.0", "latest", "1.x.0"]) {
			expect(parseVersion(value)).toBeNull();
		}
	});
});

describe("compareVersions", () => {
	it("按数值比较，不做字符串比较", () => {
		expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
		expect(compareVersions("1.9.9", "1.10.0")).toBe(-1);
		expect(compareVersions("1.7.0", "1.7.0")).toBe(0);
	});

	it("预发布版本小于同号正式版，且按段比较", () => {
		expect(compareVersions("1.8.0-beta.2", "1.8.0")).toBe(-1);
		expect(compareVersions("1.8.0-beta.2", "1.8.0-beta.10")).toBe(-1);
		expect(compareVersions("1.8.0-beta", "1.8.0-alpha")).toBe(1);
	});

	it("任一侧非法返回 null", () => {
		expect(compareVersions("1.7.0", "oops")).toBeNull();
	});
});

describe("evaluateVersionPolicy", () => {
	it("低于最低支持版本 → 强制，目标取最新版本", () => {
		expect(evaluateVersionPolicy("1.7.0", policy("1.8.0", "1.9.0"))).toEqual({
			level: "force",
			targetVersion: "1.9.0",
		});
	});

	it("最低支持版本高于最新版本（配置错误）→ 强制目标取最低支持版本", () => {
		expect(evaluateVersionPolicy("1.7.0", policy("1.9.0", "1.8.0"))).toEqual({
			level: "force",
			targetVersion: "1.9.0",
		});
	});

	it("不低于最低、但低于最新 → 软提醒", () => {
		expect(evaluateVersionPolicy("1.8.0", policy("1.8.0", "1.9.0"))).toEqual({
			level: "soft",
			targetVersion: "1.9.0",
		});
	});

	it("已是最新版本 → 无事", () => {
		expect(evaluateVersionPolicy("1.9.0", policy("1.8.0", "1.9.0"))).toEqual({
			level: "ok",
			targetVersion: "",
		});
	});

	it("当前版本高于线上最新版本（本地构建）→ 无事", () => {
		expect(evaluateVersionPolicy("9.0.0", policy("1.8.0", "1.9.0"))).toEqual({
			level: "ok",
			targetVersion: "",
		});
	});

	it("策略未配置 → 无事", () => {
		expect(evaluateVersionPolicy("1.7.0", policy("", ""))).toEqual({ level: "ok", targetVersion: "" });
	});

	it("最低支持版本非法但最新版本合法 → 只做软提醒", () => {
		expect(evaluateVersionPolicy("1.7.0", policy("oops", "1.9.0"))).toEqual({
			level: "soft",
			targetVersion: "1.9.0",
		});
	});

	it("当前版本非法 → 无事（fail-open，避免锁死开发中的构建）", () => {
		expect(evaluateVersionPolicy("dev", policy("1.8.0", "1.9.0"))).toEqual({
			level: "ok",
			targetVersion: "",
		});
	});
});

describe("shouldNotifyVersion", () => {
	it("同一目标版本只提醒一次，目标变化后重新提醒", () => {
		expect(shouldNotifyVersion("1.9.0", undefined)).toBe(true);
		expect(shouldNotifyVersion("1.9.0", "1.8.0")).toBe(true);
		expect(shouldNotifyVersion("1.9.0", "1.9.0")).toBe(false);
	});

	it("空目标不提醒", () => {
		expect(shouldNotifyVersion("", undefined)).toBe(false);
	});
});

describe("versionModalKey", () => {
	it("形态、目标版本或说明任一变化都会生成不同的 key", () => {
		expect(versionModalKey("force", "1.9.0", "说明A")).toBe("force:1.9.0:说明A");
		expect(versionModalKey("force", "1.9.0", "说明B")).not.toBe(versionModalKey("force", "1.9.0", "说明A"));
		expect(versionModalKey("soft", "1.9.0", "说明A")).not.toBe(versionModalKey("force", "1.9.0", "说明A"));
		expect(versionModalKey("force", "1.10.0", "说明A")).not.toBe(versionModalKey("force", "1.9.0", "说明A"));
	});
});

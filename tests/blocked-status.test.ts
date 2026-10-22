// 未同步文件文案：文件名、原因、折叠与兜底（设置页副行与同步回执共用同一份实现）。
import { describe, expect, it } from "vitest";
import { blockedReasonLabel, summarizeBlocked } from "../src/blocked-status";
import type { BlockedPathInfo } from "../src/sync/blocked";

const MB = 1024 * 1024;

const summary = (over: {
	blockedPaths?: string[];
	blockedDetails?: BlockedPathInfo[];
	maxFileSizeBytes?: number;
}) =>
	summarizeBlocked({
		blockedPaths: over.blockedPaths ?? [],
		blockedDetails: over.blockedDetails ?? [],
		maxFileSizeBytes: over.maxFileSizeBytes ?? 0,
	});

describe("未同步文件文案", () => {
	it("单个文件：主文案报数，明细点名文件与原因", () => {
		const s = summary({
			blockedPaths: ["附件/大图.png"],
			blockedDetails: [{ path: "附件/大图.png", reason: "oversized" }],
			maxFileSizeBytes: 5 * MB,
		});
		expect(s.count).toBe(1);
		expect(s.headline).toBe("1 个文件暂未同步");
		expect(s.detail).toBe("未同步文件：附件/大图.png（超过单文件上限 5 MB）\n其他文件不受影响");
	});

	it("四种原因各有自己的说明", () => {
		expect(blockedReasonLabel("oversized", 30 * MB)).toBe("超过单文件上限 30 MB");
		expect(blockedReasonLabel("read_failed", 30 * MB)).toBe("无法读取本地内容，下次同步会重试");
		expect(blockedReasonLabel("case_conflict", 30 * MB)).toBe("与另一项名称仅大小写不同");
		expect(blockedReasonLabel("remote_oversized", 30 * MB)).toBe(
			"云端已有内容超过单文件上限 30 MB，升级套餐后自动恢复",
		);
	});

	it("上限未知时不编造数值", () => {
		expect(blockedReasonLabel("oversized", 0)).toBe("超过单文件上限");
		expect(
			summary({ blockedPaths: ["a.md"], blockedDetails: [{ path: "a.md", reason: "oversized" }] }).detail,
		).toBe("未同步文件：a.md（超过单文件上限）\n其他文件不受影响");
	});

	it("2~3 个文件逐个列出，不折叠", () => {
		const s = summary({
			blockedPaths: ["a.md", "b.md"],
			blockedDetails: [
				{ path: "a.md", reason: "read_failed" },
				{ path: "b.md", reason: "case_conflict" },
			],
		});
		expect(s.headline).toBe("2 个文件暂未同步");
		expect(s.detail).toBe(
			"未同步文件：a.md（无法读取本地内容，下次同步会重试）、b.md（与另一项名称仅大小写不同）\n其他文件不受影响",
		);
	});

	it("超过 3 个只列前 3 个，并给出原因归类计数", () => {
		const s = summary({
			blockedPaths: ["a.md", "b.md", "c.md", "d.md", "e.md"],
			blockedDetails: [
				{ path: "a.md", reason: "oversized" },
				{ path: "b.md", reason: "oversized" },
				{ path: "c.md", reason: "oversized" },
				{ path: "d.md", reason: "read_failed" },
				{ path: "e.md", reason: "remote_oversized" },
			],
			maxFileSizeBytes: 5 * MB,
		});
		expect(s.count).toBe(5);
		expect(s.detail).toBe(
			"未同步文件：a.md（超过单文件上限 5 MB）、b.md（超过单文件上限 5 MB）、c.md（超过单文件上限 5 MB） 等 5 个文件" +
				"；其中 3 个超过单文件上限、1 个无法读取本地内容、1 个云端存量文件超限\n其他文件不受影响",
		);
	});

	it("只有路径、没有原因明细时只列文件名", () => {
		const s = summary({ blockedPaths: ["a.md", "b.md", "c.md", "d.md"] });
		expect(s.headline).toBe("4 个文件暂未同步");
		expect(s.detail).toBe("未同步文件：a.md、b.md、c.md 等 4 个文件\n其他文件不受影响");
		expect(s.files.every((file) => file.reason === null && file.reasonLabel === "")).toBe(true);
	});

	it("明细与路径重复或缺项时去重且不丢文件名", () => {
		const s = summary({
			blockedPaths: ["a.md", "b.md"],
			blockedDetails: [{ path: "a.md", reason: "oversized" }],
			maxFileSizeBytes: 5 * MB,
		});
		expect(s.count).toBe(2);
		expect(s.files).toEqual([
			{ path: "a.md", reason: "oversized", reasonLabel: "超过单文件上限 5 MB" },
			{ path: "b.md", reason: null, reasonLabel: "" },
		]);
	});

	it("没有未同步文件时不产生文案", () => {
		const s = summary({});
		expect(s).toEqual({ count: 0, headline: "", detail: "", files: [] });
	});
});

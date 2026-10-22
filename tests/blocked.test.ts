// 未同步路径的合并规则：同一路径只报一次，本地原因优先（云端超限只作展示补充）。
import { describe, expect, it } from "vitest";
import { mergeBlockedDetails } from "../src/sync/blocked";

describe("阻塞明细合并", () => {
	it("本地明细在前，云端存量超限补充在后", () => {
		expect(
			mergeBlockedDetails([{ path: "a.md", reason: "read_failed" }], ["远端大文件.zip"]),
		).toEqual([
			{ path: "a.md", reason: "read_failed" },
			{ path: "远端大文件.zip", reason: "remote_oversized" },
		]);
	});

	it("同一路径既是本地阻塞又是云端超限时只保留一条，本地原因优先", () => {
		expect(
			mergeBlockedDetails([{ path: "a.md", reason: "oversized" }], ["a.md", "b.md"]),
		).toEqual([
			{ path: "a.md", reason: "oversized" },
			{ path: "b.md", reason: "remote_oversized" },
		]);
	});

	it("本地明细里的重复路径只保留第一条", () => {
		expect(
			mergeBlockedDetails(
				[
					{ path: "a.md", reason: "oversized" },
					{ path: "a.md", reason: "read_failed" },
				],
				[],
			),
		).toEqual([{ path: "a.md", reason: "oversized" }]);
	});

	it("只有云端超限或只有本地明细时各自成立", () => {
		expect(mergeBlockedDetails([], ["x.md"])).toEqual([{ path: "x.md", reason: "remote_oversized" }]);
		expect(mergeBlockedDetails([{ path: "x.md", reason: "case_conflict" }], [])).toEqual([
			{ path: "x.md", reason: "case_conflict" },
		]);
	});

	it("空输入返回空数组", () => {
		expect(mergeBlockedDetails([], [])).toEqual([]);
	});
});

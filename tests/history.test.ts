// 历史版本纯函数测试：file_id 反查、时间/大小格式化、二进制探测、错误码判定。
// （UI 层 Modal 依赖 obsidian DOM，不可测；此处仅覆盖 history-view 抽出的纯函数）
import { describe, expect, it } from "vitest";

import {
	formatHistorySize,
	formatHistoryTime,
	isBinaryContent,
	resolveFileId,
} from "../src/history-view";
import { isBlobNotReferenced } from "../src/remote-connect";
import type { Snapshot } from "../src/sync/types";

function baseSnapshot(entries: Record<string, unknown>): Snapshot {
	return {
		schema_version: 2,
		device_id: "dev-1",
		vault_id: "42",
		base_revision: "3",
		base_root_hash: "root",
		entries: entries as Snapshot["entries"],
	};
}

describe("resolveFileId", () => {
	it("Base 未加载（未绑定）→ null", () => {
		expect(resolveFileId(null, "a.md")).toBeNull();
	});

	it("路径不在 Base（新文件/未同步）→ null", () => {
		const base = baseSnapshot({ "a.md": { state: "active", file_id: "fid-1" } });
		expect(resolveFileId(base, "b.md")).toBeNull();
	});

	it("active 条目 → 返回 file_id", () => {
		const base = baseSnapshot({ "a.md": { state: "active", file_id: "fid-1" } });
		expect(resolveFileId(base, "a.md")).toBe("fid-1");
	});

	it("deleted tombstone 同样携带 file_id（历史链仍可查）", () => {
		const base = baseSnapshot({ "a.md": { state: "deleted", file_id: "fid-1" } });
		expect(resolveFileId(base, "a.md")).toBe("fid-1");
	});

	it("条目无 file_id（dir 或旧数据）→ null", () => {
		const base = baseSnapshot({ "dir": { state: "active", kind: 2 } });
		expect(resolveFileId(base, "dir")).toBeNull();
	});
});

describe("formatHistoryTime", () => {
	it("桌面端和移动端共用：毫秒 bigint → 本地时间字符串", () => {
		const ms = 1710000000000n;
		expect(formatHistoryTime(ms)).toBe(new Date(Number(ms)).toLocaleString("zh-CN", { hour12: false }));
	});
});

describe("formatHistorySize", () => {
	it.each([
		[0n, "0 B"],
		[1n, "1 B"],
		[1023n, "1023 B"],
		[1024n, "1.0 KB"],
		[1536n, "1.5 KB"],
		[1024n * 1024n, "1.0 MB"],
		[1572864n, "1.5 MB"],
	])("%s 字节 → %s", (size, expected) => {
		expect(formatHistorySize(size)).toBe(expected);
	});
});

describe("isBinaryContent", () => {
	it("含 NUL 字节 → 二进制", () => {
		expect(isBinaryContent(new Uint8Array([0x48, 0x00, 0x49]))).toBe(true);
	});

	it("纯文本 → 非二进制", () => {
		expect(isBinaryContent(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]))).toBe(false);
	});

	it("空内容 → 非二进制", () => {
		expect(isBinaryContent(new Uint8Array())).toBe(false);
	});

	it("仅探测首 8KB（长文本 8KB 内无 NUL）", () => {
		const bytes = new Uint8Array(8192 + 16).fill(0x61); // 全部 'a'
		bytes[8200] = 0x00; // 8KB 之后的 NUL 不判定
		expect(isBinaryContent(bytes)).toBe(false);
	});
});

describe("isBlobNotReferenced", () => {
	it("12021（历史内容超保留期）→ true", () => {
		expect(isBlobNotReferenced({ code: 12021 })).toBe(true);
	});

	it("12012（Blob 缺失 GC 竞态）→ false", () => {
		expect(isBlobNotReferenced({ code: 12012 })).toBe(false);
	});

	it("无 code → false", () => {
		expect(isBlobNotReferenced(new Error("boom"))).toBe(false);
	});
});

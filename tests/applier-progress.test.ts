import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { Applier } from "../src/sync/applier";
import { sha256Hex } from "../src/sync/content-hash";
import type { SnapshotRemote } from "../src/sync/remote";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

describe("下载和本地应用进度", () => {
	it("下载按内容去重，并发乱序完成时计数和活动路径准确", async () => {
		const a = new TextEncoder().encode("a");
		const b = new TextEncoder().encode("b");
		const ha = await sha256Hex(a), hb = await sha256Hex(b);
		const first = deferred<Uint8Array>(), second = deferred<Uint8Array>();
		const getBlob = vi.fn((hash: string) => hash === ha ? first.promise : second.promise);
		const onProgress = vi.fn();
		const applier = new Applier({} as App, { getBlob } as unknown as SnapshotRemote);
		const result = applier.fetchBlobs([
			{ path: "a.md", content_hash: ha, size: "1" },
			{ path: "副本.md", content_hash: ha, size: "1" },
			{ path: "b.md", content_hash: hb, size: "1" },
		], 1n, "root", false, undefined, onProgress);
		await vi.waitFor(() => expect(getBlob).toHaveBeenCalledTimes(2));
		expect(onProgress.mock.lastCall![0]).toEqual({ completed: 0, total: 2, activePaths: ["副本.md", "b.md"] });
		second.resolve(b);
		await vi.waitFor(() => expect(onProgress.mock.lastCall![0]).toEqual({ completed: 1, total: 2, activePaths: ["副本.md"] }));
		first.resolve(a);
		expect((await result).size).toBe(2);
		expect(onProgress.mock.lastCall![0]).toEqual({ completed: 2, total: 2, activePaths: [] });
	});

	it("下载校验失败不计为完成且清除活动路径", async () => {
		const onProgress = vi.fn();
		const applier = new Applier({} as App, { getBlob: async () => new Uint8Array() } as unknown as SnapshotRemote);
		await expect(applier.fetchBlobs([{ path: "坏文件.md", content_hash: "bad", size: "0" }], 1n, "root", false, undefined, onProgress)).rejects.toThrow("下载内容校验失败");
		expect(onProgress.mock.lastCall![0]).toEqual({ completed: 0, total: 1, activePaths: [] });
	});

	it("写入、幂等目录、跳过非空目录及冲突副本都按操作计数", async () => {
		const content = new TextEncoder().encode("内容");
		const hash = await sha256Hex(content);
		const writeBinary = vi.fn(async (_path: string, _data: ArrayBuffer) => {});
		const app = { vault: {
			getFileByPath: () => null, // 索引里没有（配置目录等路径的常态）：存在性只能由 adapter 判定
			adapter: {
				// 待写入的两个目标不存在（走 write），其余路径存在（mkdir/rmdir 的判定分支）
				exists: async (path: string) => path !== "笔记.md" && path !== "冲突.md",
				list: async () => ({ files: ["非空/a.md"], folders: [] }),
				readBinary: async () => content,
				writeBinary,
			},
		} } as unknown as App;
		const onProgress = vi.fn(), onSkipped = vi.fn();
		const applier = new Applier(app, { getBlob: async () => content } as unknown as SnapshotRemote);
		const skipped = await applier.applyPlan({
			actions: [
				{ kind: "mkdir", path: "已有目录", content_hash: "", size: "0" },
				{ kind: "rmdir", path: "非空", content_hash: "", size: "0" },
				{ kind: "write", path: "笔记.md", content_hash: hash, size: String(content.length) },
			],
			conflicts: [{ path: "冲突.md", source_path: "源.md", content_hash: hash, size: String(content.length) }],
			expectedHashes: new Map(), expectedRevision: 1n, expectedRootHash: "root", tmpDir: "tmp", isMobile: false,
			onProgress, onSkipped,
		});
		expect(skipped).toEqual(["非空"]);
		expect(onSkipped).toHaveBeenCalledWith("非空");
		expect(writeBinary.mock.calls.map(([path]) => path)).toEqual(["笔记.md", "冲突.md"]);
		expect(onProgress.mock.lastCall![0]).toEqual({ completed: 4, total: 4, activePaths: [] });
	});

	it("指定临时区时下载与写盘同属一个计数单元，写盘未完成前不计为已完成", async () => {
		const content = new TextEncoder().encode("内容");
		const hash = await sha256Hex(content);
		const written = deferred<void>();
		const writeBinary = vi.fn(async (_path: string, _data: ArrayBuffer) => written.promise);
		const onProgress = vi.fn();
		const applier = new Applier(tmpApp(writeBinary), { getBlob: async () => content } as unknown as SnapshotRemote);
		const result = applier.fetchBlobs([{ path: "a.md", content_hash: hash, size: String(content.length) }], 1n, "root", false, undefined, onProgress, "tmp");
		await vi.waitFor(() => expect(writeBinary).toHaveBeenCalledTimes(1));
		// 下载已完成但写盘未落：不得显示「已完成 N/N」而仍在写盘
		expect(onProgress.mock.lastCall![0]).toEqual({ completed: 0, total: 1, activePaths: ["a.md"] });
		written.resolve();
		expect((await result).size).toBe(0); // 已落盘，不再驻留内存
		expect(onProgress.mock.lastCall![0]).toEqual({ completed: 1, total: 1, activePaths: [] });
	});

	it("同一内容多路径只写一份临时文件，写盘失败不计为完成", async () => {
		const content = new TextEncoder().encode("同内容");
		const hash = await sha256Hex(content);
		const writeBinary = vi.fn(async (_path: string, _data: ArrayBuffer) => {});
		const onProgress = vi.fn();
		const applier = new Applier(tmpApp(writeBinary), { getBlob: async () => content } as unknown as SnapshotRemote);
		const downloads = [
			{ path: "a.md", content_hash: hash, size: String(content.length) },
			{ path: "副本.md", content_hash: hash, size: String(content.length) },
		];
		const result = await applier.fetchBlobs(downloads, 1n, "root", false, undefined, onProgress, "tmp");
		expect(writeBinary.mock.calls.map(([path]) => path)).toEqual([`tmp/${hash}`]);
		expect(result.size).toBe(0);
		expect(onProgress.mock.lastCall![0]).toEqual({ completed: 1, total: 1, activePaths: [] });

		const failing = vi.fn(async (_path: string, _data: ArrayBuffer) => { throw new Error("磁盘写入失败"); });
		const failProgress = vi.fn();
		const failApplier = new Applier(tmpApp(failing), { getBlob: async () => content } as unknown as SnapshotRemote);
		await expect(failApplier.fetchBlobs(downloads, 1n, "root", false, undefined, failProgress, "tmp")).rejects.toThrow("磁盘写入失败");
		expect(failProgress.mock.lastCall![0]).toEqual({ completed: 0, total: 1, activePaths: [] });
	});
});

/** 临时区写盘所需的最小 adapter（父目录已存在，无 mkdir） */
function tmpApp(writeBinary: (path: string, data: ArrayBuffer) => Promise<void>): App {
	return { vault: { adapter: { exists: async () => true, mkdir: async () => {}, writeBinary } } } as unknown as App;
}

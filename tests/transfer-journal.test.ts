// 大文件传输痕迹：崩溃后唯一能留下的现场。阈值以下不写盘，读到即消费删除。
import { describe, expect, it } from "vitest";
import type { App } from "obsidian";

import {
	beginTransfer,
	endTransfer,
	formatTransferSize,
	readInterrupted,
	transferJournalPath,
	TRANSFER_MARK_MIN_BYTES,
} from "../src/sync/transfer-journal";

/** 最小文件系统桩：只实现痕迹用到的 exists/read/write/remove */
function fsApp(): { app: App; files: Map<string, string>; writes: number } {
	const files = new Map<string, string>();
	const state = { writes: 0 };
	const app = {
		vault: {
			adapter: {
				exists: async (p: string) => files.has(p),
				read: async (p: string) => files.get(p) ?? "",
				write: async (p: string, data: string) => {
					state.writes++;
					files.set(p, data);
				},
				remove: async (p: string) => {
					files.delete(p);
				},
			},
		},
	} as unknown as App;
	return { app, files, get writes() { return state.writes; } } as never;
}

const DIR = ".obsidian/plugins/pickpen";

describe("传输痕迹", () => {
	it("达到阈值才落盘；结束时删除", async () => {
		const { app, files } = fsApp();
		await beginTransfer(app, DIR, { kind: "upload", path: "big.mp4", bytes: TRANSFER_MARK_MIN_BYTES });
		expect(files.has(transferJournalPath(DIR))).toBe(true);
		await endTransfer(app, DIR);
		expect(files.size).toBe(0);
	});

	it("小于阈值的传输不写盘（小文件频繁，抖动不划算）", async () => {
		const { app, files } = fsApp();
		await beginTransfer(app, DIR, { kind: "download", path: "note.md", bytes: TRANSFER_MARK_MIN_BYTES - 1 });
		expect(files.size).toBe(0);
	});

	it("读取残留记录即消费：返回内容并删除文件", async () => {
		const { app, files } = fsApp();
		await beginTransfer(app, DIR, { kind: "upload", path: "视频.mp4", bytes: 30 * 1024 * 1024 });
		const mark = await readInterrupted(app, DIR);
		expect(mark).toMatchObject({ kind: "upload", path: "视频.mp4", bytes: 30 * 1024 * 1024 });
		expect(files.size).toBe(0); // 只提示一次
		expect(await readInterrupted(app, DIR)).toBeNull();
	});

	it("记录损坏时按无记录处理（不让脏文件卡住启动）", async () => {
		const { app, files } = fsApp();
		files.set(transferJournalPath(DIR), "{ 不是 JSON");
		expect(await readInterrupted(app, DIR)).toBeNull();
		expect(files.size).toBe(0);
	});

	it("体积文案按 MB 展示", () => {
		expect(formatTransferSize(30 * 1024 * 1024)).toBe("30.0 MB");
	});
});

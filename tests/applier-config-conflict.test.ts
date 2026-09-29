// 配置路径的冲突副本必须在原路径被写回远端内容**之前**取材。
// 回归背景（线上 GetBlob 12021「内容不存在」）：配置路径的副本只落本地、不参与同步
// （planner 不 put、session 跳过预上传），该 hash 永不在服务端引用集里。
// 若副本循环排在 actions 循环之后，源文件已被远端内容覆盖 → hash 对不上 →
// 回退 GetBlob(本地 hash) → 12021 → 整轮失败，且副本丢失、本地改动被静默丢弃。
import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { Applier } from "../src/sync/applier";
import { sha256Hex } from "../src/sync/content-hash";
import type { SnapshotRemote } from "../src/sync/remote";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 可变磁盘：readBinary/writeBinary 读写同一个 Map，能真实反映「原路径被 write 覆盖」 */
function fakeDisk(initial: Record<string, string>) {
	const disk = new Map<string, Uint8Array>();
	for (const [path, text] of Object.entries(initial)) disk.set(path, enc.encode(text));
	const app = {
		vault: {
			configDir: ".obsidian",
			// 配置目录里的路径没有 TFile：存在性只能由 adapter 判定
			getFileByPath: () => null,
			adapter: {
				exists: async (path: string) => disk.has(path),
				mkdir: async () => {},
				readBinary: async (path: string) => {
					const content = disk.get(path);
					if (!content) throw new Error(`ENOENT: ${path}`);
					return content;
				},
				writeBinary: async (path: string, data: ArrayBuffer) => {
					disk.set(path, new Uint8Array(data));
				},
				list: async () => ({ files: [], folders: [] }),
			},
		},
	} as unknown as App;
	const read = (path: string): string | null => {
		const content = disk.get(path);
		return content ? dec.decode(content) : null;
	};
	return { app, read };
}

describe("配置路径冲突副本", () => {
	it("取材早于原路径覆盖：不请求服务端，本地内容保住为副本", async () => {
		const remoteContent = "远端配置A";
		const localContent = "本地配置B";
		const remoteBytes = enc.encode(remoteContent);
		const localBytes = enc.encode(localContent);
		const hRemote = await sha256Hex(remoteBytes);
		const hLocal = await sha256Hex(localBytes);
		const appPath = ".obsidian/app.json";
		const copyPath = ".obsidian/app (conflict dev-1 2026-09-28T13-52-30-000Z).json";
		const tmpPath = `/tmp/${hRemote}`;

		const { app, read } = fakeDisk({
			[appPath]: localContent, // 本机那份配置（与远端冲突）
			[tmpPath]: remoteContent, // 步骤 8 已下载到临时区的远端内容
		});

		// 服务端语义：本地 hash 从未上传 → 不在 active 引用集 → 12021（与线上实测一致）
		const getBlob = vi.fn(async (hash: string) => {
			if (hash === hLocal) throw Object.assign(new Error("内容不存在"), { code: 12021 });
			return remoteBytes;
		});
		const applier = new Applier(app, { getBlob } as unknown as SnapshotRemote);

		await applier.applyPlan({
			actions: [
				{
					kind: "write",
					path: appPath,
					content_hash: hRemote,
					size: String(remoteBytes.byteLength),
					temp_path: tmpPath,
				},
			],
			conflicts: [
				{
					path: copyPath,
					source_path: appPath,
					content_hash: hLocal,
					size: String(localBytes.byteLength),
					local_only: true, // 配置路径：只落本地、不参与同步
				},
			],
			expectedHashes: new Map(),
			expectedRevision: 2n,
			expectedRootHash: "r2",
			tmpDir: "/tmp",
			isMobile: false,
		});

		expect(getBlob).not.toHaveBeenCalled(); // 配置副本一律本地取材，不请求服务端
		expect(read(copyPath)).toBe(localContent); // 本地改动保住（设计承诺：留副本）
		expect(read(appPath)).toBe(remoteContent); // 原路径仍为远端胜（既有语义不变）
	});

	it("源已失效（用户又改过）：不请求服务端，且绝不覆盖原路径", async () => {
		const remoteContent = "远端配置A";
		const stalePlanContent = "计划时的本地配置B";
		const latestContent = "用户又改的配置C"; // 计划之后被用户再次编辑
		const remoteBytes = enc.encode(remoteContent);
		const hRemote = await sha256Hex(remoteBytes);
		const hLocal = await sha256Hex(enc.encode(stalePlanContent));
		const appPath = ".obsidian/app.json";
		const copyPath = ".obsidian/app (conflict dev-1 2026-09-28T13-52-30-000Z).json";
		const tmpPath = `/tmp/${hRemote}`;

		const { app, read } = fakeDisk({
			[appPath]: latestContent, // 与副本声明的 hash 不符 → 取不到副本内容
			[tmpPath]: remoteContent,
		});

		const getBlob = vi.fn(async (hash: string) => {
			if (hash === hLocal) throw Object.assign(new Error("内容不存在"), { code: 12021 });
			return remoteBytes;
		});
		const applier = new Applier(app, { getBlob } as unknown as SnapshotRemote);

		const skipped = await applier.applyPlan({
			actions: [
				{
					kind: "write",
					path: appPath,
					content_hash: hRemote,
					size: String(remoteBytes.byteLength),
					temp_path: tmpPath,
				},
			],
			conflicts: [
				{
					path: copyPath,
					source_path: appPath,
					content_hash: hLocal,
					size: String(enc.encode(stalePlanContent).byteLength),
					local_only: true,
				},
			],
			expectedHashes: new Map(),
			expectedRevision: 2n,
			expectedRootHash: "r2",
			tmpDir: "/tmp",
			isMobile: false,
		});

		expect(getBlob).not.toHaveBeenCalled(); // 不发注定 12021 的请求
		expect(read(copyPath)).toBe(null); // 取不到内容就不落副本
		expect(read(appPath)).toBe(latestContent); // 原路径保住用户最新内容，等下轮重新对账
		expect(skipped).toEqual([appPath]); // 标脏：下一轮重新对账
	});
});

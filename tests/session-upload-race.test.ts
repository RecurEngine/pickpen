// ReconcileSession 上传期间本地文件变动恢复测试（PutBlob 声明哈希与内容不符 → 服务端 12006）：
// - 上传前重算与计划哈希不一致 → 不发请求、把路径标脏并静默重排一轮，下一轮收敛（不留红字）
// - 服务端仍返回 12006 → 走同一条重排路径
// - 文件被持续改写 → 连续命中达阈值后报错，不空转
// - 正常路径不变量：putBlob 收到的 hash 恒等于所收字节的 SHA-256
// backoffMs 归零使退避可测；其余依赖保持真实。
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/sync/content-hash";
import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import { ReconcileSession } from "../src/sync/session";
import type { BaseStore } from "../src/sync/base-store";
import type { PendingStore } from "../src/sync/pending-store";
import type { SnapshotRemote } from "../src/sync/remote";
import type { Snapshot } from "../src/sync/types";

vi.mock("../src/sync/utils", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/sync/utils")>();
	return { ...orig, backoffMs: () => 0 };
});

const enc = new TextEncoder();

function fakeDeps(
	overrides: {
		onHasBlobs?: (round: number) => void;
		putBlob?: SnapshotRemote["putBlob"];
		baseEntries?: Snapshot["entries"];
		manifestEntries?: Snapshot["entries"];
		head?: { revision?: bigint; rootHash?: string; unchanged?: boolean };
		/** hash → 明文内容：合并阶段读 Base 版本与 Remote 版本走这里 */
		blobs?: Map<string, Uint8Array>;
	} = {},
) {
	const base: Snapshot = {
		schema_version: 2,
		device_id: "dev-1",
		vault_id: "42",
		base_revision: "1",
		base_root_hash: "r1",
		entries: overrides.baseEntries ?? {},
	};
	// 磁盘内容只由 onHasBlobs 改写：hasBlobs 是 step 9 复查之后、读取待上传字节之前的那一步，
	// 正好落在「计划已算好、正文还没读」的窗口里
	let content = enc.encode("v0");
	// 写盘产物（临时区/落盘）按路径回读：合并产物走的就是这条路
	const written = new Map<string, Uint8Array>();
	let round = 0;
	const file = { path: "a.md", stat: { mtime: 1, size: 2 } };
	return {
		setContent: (s: string) => {
			content = enc.encode(s);
		},
		written,
		deps: {
			app: {
				vault: {
					configDir: ".obsidian",
					adapter: {
						readBinary: vi.fn(async (path: string) => written.get(path) ?? new Uint8Array(content)),
						writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
							written.set(path, new Uint8Array(data));
						}),
						stat: vi.fn(async () => null),
						read: vi.fn(async () => ""),
						exists: vi.fn(async () => false),
						mkdir: vi.fn(async () => {}),
						rmdir: vi.fn(async () => {}),
					},
					getFiles: () => [file],
					getAllLoadedFiles: () => [],
					// dirty 增量刷新靠它判定「不是删除」，必须返回非空
					getFileByPath: () => file,
					getAbstractFileByPath: () => null,
					trash: vi.fn(async () => {}),
				},
				workspace: { getLeavesOfType: () => [] },
			},
			getSettings: () => ({ accessToken: "t", vaultId: "42", deviceId: "dev-1" }),
			baseStore: {
				getBase: vi.fn(() => base as Snapshot | null),
				saveBase: vi.fn(async () => {}),
				reset: vi.fn(),
				flush: vi.fn(async () => {}),
			} as unknown as BaseStore,
			pendingStore: {
				getPending: () => null,
				writePrepared: vi.fn(async () => {}),
				markCommitted: vi.fn(async () => {}),
				markApplying: vi.fn(async () => {}),
				clear: vi.fn(async () => {}),
			} as unknown as PendingStore,
			localBuilder: new LocalSnapshotBuilder(),
			pluginDir: ".obsidian/plugins/pickpen",
			pluginId: "pickpen",
			remote: {
				pollHead: vi.fn(async () => ({
					revision: overrides.head?.revision ?? 1n,
					rootHash: overrides.head?.rootHash ?? "r1",
					unchanged: overrides.head?.unchanged ?? true,
					syncIntervalMs: 0n,
					maxFileSizeBytes: 30n * 1024n * 1024n,
					localDebounceMs: 0n,
				})),
				getManifest: vi.fn(async () => ({ entries: overrides.manifestEntries ?? {} })),
				getHead: vi.fn(),
				hasBlobs: vi.fn(async () => {
					overrides.onHasBlobs?.(++round);
					return new Set<string>();
				}),
				putBlob: overrides.putBlob ?? vi.fn(async () => {}),
				getBlob: vi.fn(async (hash: string) => overrides.blobs?.get(hash) ?? new Uint8Array()),
				commitSnapshot: vi.fn(async () => ({ revision: 2n, rootHash: "r2", changed: true })),
			} as unknown as SnapshotRemote,
			caseInsensitive: false,
			onStatus: vi.fn(),
		},
	};
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function waitForIdle(session: ReconcileSession): Promise<void> {
	for (let i = 0; i < 100 && session.isRunning(); i++) await tick();
}

function lastStatus(deps: { onStatus: unknown }) {
	const onStatus = deps.onStatus as ReturnType<typeof vi.fn>;
	return onStatus.mock.calls[onStatus.mock.calls.length - 1]?.[0] as {
		lastError: string;
		allSynced: boolean;
	};
}

describe("ReconcileSession 上传期间本地变动", () => {
	it("上传前本地被改动 → 本轮不发请求、静默重排，下一轮收敛", async () => {
		const putBlob = vi.fn<SnapshotRemote["putBlob"]>(async () => {});
		const { deps, setContent } = fakeDeps({
			onHasBlobs: (round) => {
				if (round === 1) setContent("v2-changed"); // 只改一次：模拟用户编辑落盘
			},
			putBlob,
		});
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		// 第一轮：上传前发现字节已变 → 一个 PutBlob 都不发（服务端 12006 无从发生）
		// 第二轮：按新内容重新对账 → 恰好一次上传
		expect(deps.remote.hasBlobs).toHaveBeenCalledTimes(2);
		expect(putBlob).toHaveBeenCalledTimes(1);
		const [hash, bytes] = putBlob.mock.calls[0]!;
		expect(hash).toBe(await sha256Hex(bytes));
		expect(new TextDecoder().decode(bytes)).toBe("v2-changed");
		const last = lastStatus(deps);
		expect(last.lastError).toBe(""); // 静默收敛：不出现「文件哈希非法」红字
		expect(last.allSynced).toBe(true);
	});

	it("服务端仍返回 12006 → 走同一条重排路径，下一轮成功", async () => {
		const putBlob = vi
			.fn<SnapshotRemote["putBlob"]>()
			.mockImplementationOnce(async () => {
				throw Object.assign(new Error("文件哈希非法"), { code: 12006 });
			})
			.mockImplementation(async () => {});
		const { deps } = fakeDeps({ putBlob });
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(putBlob).toHaveBeenCalledTimes(2); // 失败一次 + 重排后成功一次
		expect(deps.remote.commitSnapshot).toHaveBeenCalledTimes(1);
		expect(lastStatus(deps).lastError).toBe("");
	});

	it("文件被持续改写 → 连续命中达阈值后报错，不空转", async () => {
		let n = 0;
		const putBlob = vi.fn<SnapshotRemote["putBlob"]>(async () => {});
		const { deps, setContent } = fakeDeps({
			onHasBlobs: () => setContent(`v${++n}`), // 每轮上传前都再改一次
			putBlob,
		});
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(deps.remote.hasBlobs).toHaveBeenCalledTimes(3); // 2 次静默重排 + 第 3 次转为报错
		expect(putBlob).not.toHaveBeenCalled();
		expect(lastStatus(deps).lastError).toBe("同步失败：本地文件在上传期间持续变动，请稍后重试");
	});

	it("正常路径不变量：声明 hash 恒等于上传字节的 SHA-256", async () => {
		const putBlob = vi.fn<SnapshotRemote["putBlob"]>(async () => {});
		const { deps } = fakeDeps({ putBlob });
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(putBlob).toHaveBeenCalledTimes(1);
		const [hash, bytes] = putBlob.mock.calls[0]!;
		expect(hash).toBe(await sha256Hex(bytes));
		expect(deps.remote.commitSnapshot).toHaveBeenCalledTimes(1);
		expect(lastStatus(deps).lastError).toBe("");
	});
});

describe("ReconcileSession 上传合并产物（暂存区）", () => {
	// Base / Remote / Local 各改一处不同位置 → 干净三方合并，产物进临时区再由上传读取
	const BASE_TEXT = "a\nb\nc\nd\ne\n";
	const LOCAL_TEXT = "a\nB-local\nc\nd\ne\n";
	const REMOTE_TEXT = "a\nb\nc\nd\nE-remote\n";

	async function mergeDeps(overrides: { onHasBlobs?: () => void; putBlob?: SnapshotRemote["putBlob"] } = {}) {
		const baseHash = await sha256Hex(enc.encode(BASE_TEXT));
		const remoteHash = await sha256Hex(enc.encode(REMOTE_TEXT));
		const entry = (hash: string, text: string): Snapshot["entries"][string] => ({
			state: "active",
			kind: 1,
			content_hash: hash,
			size: String(enc.encode(text).byteLength),
			file_id: "fid-1",
		});
		const blobs = new Map<string, Uint8Array>([
			[baseHash, enc.encode(BASE_TEXT)],
			[remoteHash, enc.encode(REMOTE_TEXT)],
		]);
		return fakeDeps({
			baseEntries: { "a.md": entry(baseHash, BASE_TEXT) },
			manifestEntries: { "a.md": entry(remoteHash, REMOTE_TEXT) },
			head: { revision: 2n, rootHash: "r2", unchanged: false },
			blobs,
			onHasBlobs: overrides.onHasBlobs,
			putBlob: overrides.putBlob,
		});
	}

	it("合并产物经暂存区上传：校验通过，内容含双方改动", async () => {
		const putBlob = vi.fn<SnapshotRemote["putBlob"]>(async () => {});
		const { deps, setContent } = await mergeDeps({ putBlob });
		setContent(LOCAL_TEXT);
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(putBlob).toHaveBeenCalledTimes(1);
		const [hash, bytes] = putBlob.mock.calls[0]!;
		expect(hash).toBe(await sha256Hex(bytes)); // 暂存区校验未误伤合并产物
		const merged = new TextDecoder().decode(bytes);
		expect(merged).toContain("B-local");
		expect(merged).toContain("E-remote");
		expect(lastStatus(deps).lastError).toBe("");
	});

	it("暂存区产物被破坏 → 硬错误，不静默重排", async () => {
		const putBlob = vi.fn<SnapshotRemote["putBlob"]>(async () => {});
		const { deps, written, setContent } = await mergeDeps({
			onHasBlobs: () => {
				// hasBlobs 恰在「合并产物已落临时区、上传还没读它」之间
				for (const [path, bytes] of written) {
					if (path.includes("/tmp/")) written.set(path, new Uint8Array([...bytes, 0x21]));
				}
			},
			putBlob,
		});
		setContent(LOCAL_TEXT);
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(putBlob).not.toHaveBeenCalled();
		expect(deps.remote.hasBlobs).toHaveBeenCalledTimes(1); // 不重排
		expect(lastStatus(deps).lastError).toBe("同步失败：合并产物临时文件校验失败：a.md");
	});
});

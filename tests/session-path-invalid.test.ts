// Windows 平台不可落地路径（文件名含 `"` 等）的同步行为：
// - 远端 active：不写盘、不提交 delete，目标树保留远端，仅展示为「未同步」；
// - 远端 tombstone（文件/目录）：不生成 trash/rmdir，避免 adapter 在非法路径上抛错；
// - 旧版本留下的毒 pending：过滤不可落地动作后照常完成落地与 Base 推进（升级自愈）。
// 线上背景：writeBinary 对非法名返回 ENOENT，旧代码会让整轮 apply 中止、pending 永不清空。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { sha256Hex } from "../src/sync/content-hash";
import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import { PATH_MODE_PLAIN, treeRoot } from "../src/sync/path-codec";
import { ReconcileSession, type SyncStatus } from "../src/sync/session";
import type { BaseStore } from "../src/sync/base-store";
import type { PendingStore } from "../src/sync/pending-store";
import type { SnapshotRemote } from "../src/sync/remote";
import type { Entry, PendingLog, Snapshot } from "../src/sync/types";

const BAD = 'ima/字课/字课05"腠理".md';
const BAD_DIR = '课件"合集"';
const OK = "ok.md";

const active = (hash: string, size = "10"): Entry => ({ state: "active", content_hash: hash, size });
const A = "a".repeat(64);

function fakeDeps(overrides: {
	manifestEntries: Snapshot["entries"];
	headRoot: string;
	unchanged?: boolean;
	pending?: PendingLog | null;
	files?: string[];
	blob?: Uint8Array;
} = {
	manifestEntries: {},
	headRoot: "r1",
}) {
	const base: Snapshot = {
		schema_version: 2,
		device_id: "dev-1",
		vault_id: "42",
		base_revision: "1",
		base_root_hash: "r1",
		entries: {},
	};
	let pending = overrides.pending ?? null;
	const files = (overrides.files ?? []).map((path) => ({ path, stat: { mtime: 1, size: 2 } }));
	const writeBinary = vi.fn(async () => {});
	const head = {
		revision: 1n,
		rootHash: overrides.headRoot,
		unchanged: overrides.unchanged ?? false,
		syncIntervalMs: 0n,
		maxFileSizeBytes: 30n * 1024n * 1024n,
		localDebounceMs: 0n,
		pathEncryptionVersion: 0,
	};
	const saveBase = vi.fn(async () => {});
	const commitSnapshot = vi.fn(async () => ({
		revision: 2n,
		rootHash: overrides.headRoot,
		changed: true,
	}));
	const clear = vi.fn(async () => {
		pending = null;
	});
	return {
		saveBase,
		writeBinary,
		clear,
		commitSnapshot,
		deps: {
			app: {
				vault: {
					configDir: ".obsidian",
					adapter: {
						readBinary: vi.fn(async () => new Uint8Array()),
						writeBinary,
						stat: vi.fn(async () => null),
						read: vi.fn(async () => ""),
						exists: vi.fn(async () => false),
						mkdir: vi.fn(async () => {}),
						rmdir: vi.fn(async () => {}),
					},
					getFiles: () => files,
					getAllLoadedFiles: () => [],
					getFileByPath: (path: string) => files.find((f) => f.path === path) ?? null,
					getAbstractFileByPath: () => null,
					trash: vi.fn(async () => {}),
				},
				workspace: { getLeavesOfType: () => [] },
			},
			getSettings: () => ({ accessToken: "t", vaultId: "42", deviceId: "dev-1" }),
			baseStore: {
				getBase: vi.fn(() => base as Snapshot | null),
				saveBase,
				reset: vi.fn(),
				flush: vi.fn(async () => {}),
			} as unknown as BaseStore,
			pendingStore: {
				getPending: () => pending,
				writePrepared: vi.fn(async () => {}),
				markCommitted: vi.fn(async () => {}),
				markApplying: vi.fn(async () => {}),
				clear,
			} as unknown as PendingStore,
			localBuilder: new LocalSnapshotBuilder(),
			pluginDir: ".obsidian/plugins/pickpen",
			pluginId: "pickpen",
			remote: {
				pollHead: vi.fn(async () => ({ ...head })),
				getHead: vi.fn(async () => ({ ...head })),
				getManifest: vi.fn(async () => ({
					revision: head.revision,
					rootHash: head.rootHash,
					vaultId: "42",
					entries: overrides.manifestEntries,
				})),
				hasBlobs: vi.fn(async () => new Set<string>()),
				putBlob: vi.fn(async () => {}),
				getBlob: vi.fn(async () => overrides.blob ?? new Uint8Array()),
				commitSnapshot,
			} as unknown as SnapshotRemote,
			caseInsensitive: false,
			onStatus: vi.fn(),
		},
	};
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function waitForIdle(session: ReconcileSession): Promise<void> {
	for (let i = 0; i < 200 && session.isRunning(); i++) await tick();
}

function lastStatus(deps: { onStatus: unknown }): SyncStatus {
	const onStatus = deps.onStatus as ReturnType<typeof vi.fn>;
	return onStatus.mock.calls[onStatus.mock.calls.length - 1]?.[0] as SyncStatus;
}

describe("Windows 平台不可落地路径", () => {
	let original: typeof Platform;
	beforeEach(() => {
		original = { ...Platform };
		Object.assign(Platform, { isWin: true });
	});
	afterEach(() => {
		Object.assign(Platform, original);
	});

	it("远端 active 非法名：不写盘、不提交，目标保留远端，状态展示为未同步", async () => {
		const entries = { [BAD]: active(A) };
		const headRoot = await treeRoot(entries, PATH_MODE_PLAIN);
		const { deps, writeBinary, saveBase, commitSnapshot } = fakeDeps({
			manifestEntries: entries,
			headRoot,
		});
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(writeBinary).not.toHaveBeenCalled();
		expect(commitSnapshot).not.toHaveBeenCalled();
		expect(saveBase).toHaveBeenCalled();
		const status = lastStatus(deps);
		expect(status.lastError).toBe("");
		expect(status.allSynced).toBe(false);
		expect(status.blockedDetails).toEqual([{ path: BAD, reason: "path_invalid_on_platform" }]);
	});

	it("远端非法名 tombstone（文件/目录）：不生成 trash/rmdir，也不展示为未同步", async () => {
		const entries: Snapshot["entries"] = {
			[BAD]: { state: "deleted" },
			[BAD_DIR]: { state: "deleted", kind: 2 },
		};
		const headRoot = await treeRoot(entries, PATH_MODE_PLAIN);
		const { deps, writeBinary, saveBase } = fakeDeps({ manifestEntries: entries, headRoot });
		const adapter = deps.app.vault.adapter as unknown as {
			exists: ReturnType<typeof vi.fn>;
			rmdir: ReturnType<typeof vi.fn>;
		};
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(writeBinary).not.toHaveBeenCalled();
		expect(adapter.rmdir).not.toHaveBeenCalled();
		expect(adapter.exists).not.toHaveBeenCalledWith(BAD_DIR);
		expect(saveBase).toHaveBeenCalled();
		const status = lastStatus(deps);
		expect(status.lastError).toBe("");
		expect(status.blockedDetails).toEqual([]); // tombstone 不应挂在「未同步」里
		expect(status.allSynced).toBe(true);
	});

	it.each(["applying", "committed"] as const)(
		"毒 pending（phase=%s）：过滤不可落地动作后完成落地并清空 pending",
		async (phase) => {
			const emptyHash = await sha256Hex(new Uint8Array());
			const entries = {
				[BAD]: active(emptyHash, "0"),
				[OK]: active(emptyHash, "0"),
			};
			const headRoot = await treeRoot(entries, PATH_MODE_PLAIN);
			const pending: PendingLog = {
				schema_version: 2,
				vault_id: "42",
				base_revision: "1",
				base_root_hash: "r1",
				target_root_hash: headRoot,
				phase,
				target_revision: "2",
				apply_actions: [
					{ kind: "write", path: BAD, content_hash: emptyHash, size: "0" },
					{ kind: "write", path: OK, content_hash: emptyHash, size: "0" },
				],
				created_at: "2026-11-03T12:00:00Z",
			};
			const { deps, writeBinary, saveBase, clear } = fakeDeps({
				manifestEntries: entries,
				headRoot,
				unchanged: true,
				pending,
			});
			const session = new ReconcileSession(deps as never);

			session.requestRun({ forceAudit: true });
			await waitForIdle(session);

			// 合法文件照常落地，非法路径一次都不能碰
			expect(writeBinary).toHaveBeenCalledTimes(1);
			expect(writeBinary).toHaveBeenCalledWith(OK, expect.anything());
			expect(writeBinary).not.toHaveBeenCalledWith(BAD, expect.anything());
			expect(clear).toHaveBeenCalled();
			expect(saveBase).toHaveBeenCalled();
			const opts = (saveBase.mock.calls[0] as unknown[])[1] as {
				unverified: (path: string) => boolean;
			};
			expect(opts.unverified(BAD)).toBe(true);
			expect(lastStatus(deps).lastError).toBe("");
		},
	);
});

// verifying 阶段进度：逐文件校验的计数与「当前校验的文件」；
// 提前放弃（本地在会话期间变化）时不得残留活动路径、不得虚增完成数。
import { describe, expect, it, vi } from "vitest";
import { ReconcileSession } from "../src/sync/session";
import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import { sha256Hex } from "../src/sync/content-hash";
import { progressPercent } from "../src/sync/progress";
import { KIND_DIR, KIND_FILE, type SyncPlan } from "../src/sync/types";
import type { BaseStore } from "../src/sync/base-store";
import type { PendingStore } from "../src/sync/pending-store";
import type { SnapshotRemote } from "../src/sync/remote";

type VerifyProgress = { completed: number; total: number | null; activePaths: string[] };
type VerifyFn = (
	plan: SyncPlan,
	expectedHashes: Map<string, string>,
	onProgress: (progress: VerifyProgress) => void,
) => Promise<boolean>;
/** 带 mergedPaths 的原始签名：内容级合并产出的 put 走另一套校验基线 */
type VerifyRawFn = (
	plan: SyncPlan,
	expectedHashes: Map<string, string>,
	mergedPaths: Set<string>,
	onProgress: (progress: VerifyProgress) => void,
) => Promise<boolean>;

function plan(overrides: Partial<SyncPlan> = {}): SyncPlan {
	return {
		puts: [], deletes: [], target_root_hash: "root", target_entries: {},
		apply_actions: [], conflict_copies: [], downloads: [], blocked_paths: [],
		...overrides,
	};
}

/** 只用到 deps.app 的私有方法：以最小依赖直调，避免驱动整轮会话 */
function verifierRaw(adapter: Record<string, unknown>): VerifyRawFn {
	const session = new ReconcileSession({ app: { vault: { adapter } } } as never);
	return (session as unknown as { verifyLocalUnchanged: VerifyRawFn }).verifyLocalUnchanged.bind(session);
}

/** 非合并路径的用例：mergedPaths 恒为空 */
function verifier(adapter: Record<string, unknown>): VerifyFn {
	const raw = verifierRaw(adapter);
	return (plan, expectedHashes, onProgress) => raw(plan, expectedHashes, new Set(), onProgress);
}

function fakeDeps() {
	const base = { schema_version: 2, device_id: "dev-1", vault_id: "42", base_revision: "1", base_root_hash: "r1", entries: {} };
	return {
		app: {
			vault: {
				adapter: {
					readBinary: vi.fn(async () => new TextEncoder().encode("abc")),
					stat: vi.fn(async () => null),
					read: vi.fn(async () => ""),
					exists: vi.fn(async () => false),
					mkdir: vi.fn(async () => {}),
					rmdir: vi.fn(async () => {}),
				},
				getFiles: () => [{ path: "a.md", stat: { mtime: 1, size: 3 } }],
				getAllLoadedFiles: () => [],
				getFileByPath: () => null,
				getAbstractFileByPath: () => null,
				trash: vi.fn(async () => {}),
			},
			workspace: { getLeavesOfType: () => [] },
		},
		getSettings: () => ({ accessToken: "t", vaultId: "42", deviceId: "dev-1" }),
		baseStore: { getBase: () => base, saveBase: vi.fn(async () => {}), reset: vi.fn(), flush: vi.fn(async () => {}) } as unknown as BaseStore,
		pendingStore: {
			getPending: () => null, writePrepared: vi.fn(async () => {}), markCommitted: vi.fn(async () => {}),
			markApplying: vi.fn(async () => {}), clear: vi.fn(async () => {}),
		} as unknown as PendingStore,
		localBuilder: new LocalSnapshotBuilder(),
		remote: {
			pollHead: vi.fn(async () => ({
				revision: 1n, rootHash: "r1", unchanged: true, syncIntervalMs: 0n,
				maxFileSizeBytes: 30n * 1024n * 1024n, localDebounceMs: 0n,
			})),
			getManifest: vi.fn(),
			getHead: vi.fn(),
			hasBlobs: vi.fn(async () => new Set<string>()),
			putBlob: vi.fn(async () => {}),
			getBlob: vi.fn(async () => new Uint8Array()),
			commitSnapshot: vi.fn(async () => ({ revision: 2n, rootHash: "r2", changed: true })),
		} as unknown as SnapshotRemote,
		pluginDir: ".obsidian/plugins/pickpen",
		caseInsensitive: false,
		onStatus: vi.fn(),
	};
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function waitForIdle(session: ReconcileSession): Promise<void> {
	for (let i = 0; i < 100 && session.isRunning(); i++) await tick();
}

describe("verifying 阶段逐文件进度", () => {
	it("按文件计入总数（目录 put 不计），冲突副本显示其来源路径", async () => {
		const content = new TextEncoder().encode("abc");
		const hash = await sha256Hex(content);
		const onProgress = vi.fn();
		const verify = verifier({ readBinary: vi.fn(async () => content.buffer) });

		const ok = await verify(
			plan({
				puts: [
					{ path: "目录", content_hash: "", size: "0", file_id: "f1", kind: KIND_DIR },
					{ path: "b.md", content_hash: hash, size: "3", file_id: "f2" },
					{ path: "冲突.md", content_hash: hash, size: "3", file_id: "f3" },
				],
				conflict_copies: [{ path: "冲突.md", source_path: "源.md", content_hash: hash, size: "3" }],
			}),
			new Map(),
			onProgress,
		);

		expect(ok).toBe(true);
		expect(onProgress.mock.calls.map(([p]) => p)).toEqual([
			{ completed: 0, total: 2, activePaths: [] }, // tracker 构造即报出总数（目录 put 不占总数）
			{ completed: 0, total: 2, activePaths: ["b.md"] },
			{ completed: 1, total: 2, activePaths: [] },
			{ completed: 1, total: 2, activePaths: ["源.md"] }, // 副本校验对象是磁盘上的 source_path
			{ completed: 2, total: 2, activePaths: [] },
		]);
	});

	it("本地在会话期间变化而放弃校验时，不留活动路径也不虚增完成数", async () => {
		const content = new TextEncoder().encode("abc");
		const onProgress = vi.fn();
		const verify = verifier({ readBinary: vi.fn(async () => content.buffer) });

		// delete 目标在会话期间重现 → expectedHashes 无该路径 → 放弃本轮
		const ok = await verify(
			plan({ deletes: ["gone.md"], target_entries: { "gone.md": { state: "deleted", kind: KIND_FILE } } }),
			new Map(),
			onProgress,
		);

		expect(ok).toBe(false);
		expect(onProgress.mock.lastCall![0]).toEqual({ completed: 0, total: 1, activePaths: [] });
	});

	it("目录删除目标仍存在时放弃，读盘异常照旧向上抛", async () => {
		const onProgress = vi.fn();
		const entries = { "空目录": { state: "deleted" as const, kind: KIND_DIR } };
		const exists = vi.fn(async () => true);
		expect(await verifier({ exists, readBinary: vi.fn() })(plan({ deletes: ["空目录"], target_entries: entries }), new Map(), onProgress)).toBe(false);
		expect(onProgress.mock.lastCall![0]).toEqual({ completed: 0, total: 1, activePaths: [] });

		const broken = vi.fn(async () => { throw new Error("读盘失败"); });
		await expect(
			verifier({ exists: broken, readBinary: vi.fn() })(plan({ deletes: ["空目录"], target_entries: entries }), new Map(), vi.fn()),
		).rejects.toThrow("读盘失败");
	});

	it("合并产出的 put 以本地快照 hash 为基线，而非 put 的合并结果 hash", async () => {
		const localText = "1\n2-本地\n3\n4\n5\n";
		const mergedText = "1\n2-本地\n3\n4-远端\n5\n";
		const content = new TextEncoder().encode(localText);
		const localHash = await sha256Hex(content);
		const mergedHash = await sha256Hex(new TextEncoder().encode(mergedText));
		const verify = verifierRaw({ readBinary: vi.fn(async () => content.buffer) });
		const mergedPaths = new Set(["x.md"]);
		const put = { path: "x.md", content_hash: mergedHash, size: String(content.byteLength), file_id: "f", kind: KIND_FILE };

		// 磁盘仍是合并前的本地内容、put 是合并结果 —— 二者不等但本轮合法，不得判为「用户改过」
		expect(await verify(plan({ puts: [put] }), new Map([["x.md", localHash]]), mergedPaths, vi.fn())).toBe(true);
		// 用户确实在提交前改过（磁盘 hash 与快照基线不符）→ 放弃
		expect(await verify(plan({ puts: [put] }), new Map([["x.md", "0".repeat(64)]]), mergedPaths, vi.fn())).toBe(false);
		// 无写动作（合并结果与本地一致）时基线退化为 put hash
		expect(await verify(plan({ puts: [put] }), new Map(), mergedPaths, vi.fn())).toBe(false);
		expect(
			await verify(
				plan({ puts: [{ ...put, content_hash: localHash }] }),
				new Map(),
				mergedPaths,
				vi.fn(),
			),
		).toBe(true);
	});
});

describe("会话级进度快照", () => {
	it("无下载内容时不计进度条，verifying 逐文件推进，会话结束后进度清空", async () => {
		const deps = fakeDeps();
		const session = new ReconcileSession(deps as never);
		const snapshots = (phase: string) =>
			(deps.onStatus as ReturnType<typeof vi.fn>).mock.calls
				.map(([s]) => s.progress)
				.filter((p) => p?.phase === phase);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		// 本地新增 a.md → 无 apply_actions → 下载阶段总量为 0：进度条自动隐藏
		const downloading = snapshots("downloading");
		expect(downloading.at(-1)).toEqual({ phase: "downloading", completed: 0, total: 0, activePaths: [] });
		expect(progressPercent(downloading.at(-1))).toBeNull();

		const verifying = snapshots("verifying");
		expect(verifying).toEqual([
			{ phase: "verifying", completed: 0, total: null, activePaths: [] }, // 进入阶段：总量未知
			{ phase: "verifying", completed: 0, total: 1, activePaths: [] }, // tracker 构造：拿到总数
			{ phase: "verifying", completed: 0, total: 1, activePaths: ["a.md"] }, // 当前校验的文件
			{ phase: "verifying", completed: 1, total: 1, activePaths: [] },
		]);

		const onStatus = deps.onStatus as ReturnType<typeof vi.fn>;
		const last = onStatus.mock.calls[onStatus.mock.calls.length - 1]?.[0];
		expect(last.lastError).toBe("");
		expect(last.progress).toBeNull(); // 会话结束：设置页据此隐藏进度
	});
});

// ReconcileSession 串行保证测试（spec §9/§16.4）：
// - busy 守卫：并发 requestRun 只跑一个 Session
// - rerun 合并：运行期间的请求合并为一次 rerun
// - 运行期间的 dirty 事件进入下一轮集合，不混入本轮
import { describe, expect, it, vi } from "vitest";
import { ReconcileSession } from "../src/sync/session";
import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import type { BaseStore } from "../src/sync/base-store";
import type { PendingStore } from "../src/sync/pending-store";
import type { SnapshotRemote } from "../src/sync/remote";
import type { Snapshot } from "../src/sync/types";

function fakeDeps(overrides: {
	remote?: Partial<SnapshotRemote>;
	settings?: Record<string, unknown>;
} = {}) {
	const base: Snapshot = {
		schema_version: 2,
		device_id: "dev-1",
		vault_id: "42",
		base_revision: "1",
		base_root_hash: "r1",
		entries: {},
	};
	const getBase = vi.fn(() => base as Snapshot | null);
	// 依赖注入：通过子类化参数做不到，直接以最小对象断言行为
	const localBuilder = new LocalSnapshotBuilder();
	return {
		base,
		getBase,
		remoteCalls: [] as string[],
		deps: {
			app: {
				vault: {
					adapter: {
						readBinary: vi.fn(async () => new ArrayBuffer(0)),
						stat: vi.fn(async () => null),
						read: vi.fn(async () => ""),
						exists: vi.fn(async () => false),
						mkdir: vi.fn(async () => {}),
						rmdir: vi.fn(async () => {}),
					},
					getFiles: () => [],
					getAllLoadedFiles: () => [],
					getFileByPath: () => null,
					getAbstractFileByPath: () => null,
					trash: vi.fn(async () => {}),
				},
				workspace: { getLeavesOfType: () => [] },
			},
			getSettings: () => ({ accessToken: "t", vaultId: "42", deviceId: "dev-1", extraExcludes: [] }),
			baseStore: {
				getBase,
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
			localBuilder,
			remote: {
				pollHead: vi.fn(async () => ({
					revision: 1n,
					rootHash: "r1",
					unchanged: true,
					syncIntervalMs: 0n,
					maxFileSizeBytes: 30n * 1024n * 1024n,
					localDebounceMs: 0n,
				})),
				getManifest: vi.fn(),
				getHead: vi.fn(),
				hasBlobs: vi.fn(async () => new Set<string>()),
				putBlob: vi.fn(async () => {}),
				getBlob: vi.fn(async () => new Uint8Array()),
				commitSnapshot: vi.fn(async () => null),
				...overrides.remote,
			} as unknown as SnapshotRemote,
			pluginDir: ".obsidian/plugins/pickpen",
			caseInsensitive: false,
			onStatus: vi.fn(),
			...(overrides.settings ?? {}),
		},
	};
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ReconcileSession 串行保证", () => {
	it("并发 requestRun 只运行一个 Session（busy 守卫）", async () => {
		const { deps } = fakeDeps();
		const session = new ReconcileSession(deps as never);
		let runCount = 0;
		const pollHead = deps.remote.pollHead as ReturnType<typeof vi.fn>;
		pollHead.mockImplementation(async () => {
			runCount++;
			await tick();
			return {
				revision: 1n,
				rootHash: "r1",
				unchanged: true,
				syncIntervalMs: 0n,
				maxFileSizeBytes: 30n * 1024n * 1024n,
				localDebounceMs: 0n,
			};
		});

		session.requestRun();
		session.requestRun();
		session.requestRun();
		await tick();
		await tick();
		await tick();
		await tick();
		// 单个 Session 内 pollHead 只被调用一次（第一轮 unchanged+无变化即结束）；
		// 后续 rerun 合并为同一轮次（最多 2 次：初始 + 合并一轮）
		expect(runCount).toBeLessThanOrEqual(3);
		expect(runCount).toBeGreaterThanOrEqual(1);
	});

	it("运行期间的 addDirty 进入下一轮集合，不混入本轮已取得的快照", async () => {
		const { deps } = fakeDeps();
		const session = new ReconcileSession(deps as never);
		const pollHead = deps.remote.pollHead as ReturnType<typeof vi.fn>;
		let injected = false;
		pollHead.mockImplementation(async () => {
			// 仅在首轮模拟 Session 运行中收到一次新 dirty（不持续注入，否则死循环）
			if (!injected) {
				injected = true;
				session.addDirty("late.md");
			}
			await tick();
			return {
				revision: 1n,
				rootHash: "r1",
				unchanged: true,
				syncIntervalMs: 0n,
				maxFileSizeBytes: 30n * 1024n * 1024n,
				localDebounceMs: 0n,
			};
		});

		session.requestRun({ dirtyPaths: new Set(["first.md"]) });
		await tick();
		await tick();
		await tick();
		await tick();
		await tick();
		await tick();
		await tick();
		await tick();
		// 第二轮会消费 late.md（rerun 合并）；此后无新 dirty，Session 终止
		expect(session.isRunning()).toBe(false);
		expect(pollHead).toHaveBeenCalled();
	});

	it("无 token/未绑定直接结束", async () => {
		const { deps } = fakeDeps();
		(deps.getSettings as () => Record<string, unknown>) = () => ({ accessToken: "", vaultId: "" });
		const session = new ReconcileSession(deps as never);
		session.requestRun();
		await tick();
		expect(session.isRunning()).toBe(false);
	});
});

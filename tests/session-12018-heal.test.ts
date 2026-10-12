// ReconcileSession 12018（清单校验失败）自愈测试：
// - 本地基线可能与 Head 声明不符（老版本曾把阻塞路径的目标条目钉在过期 Base 上落盘），
//   而 Head 恰好匹配 → 快路径把过期条目当成远端真值 → 凡有本地改动都算错 target_root_hash
// - 第一次 commit 抛 12018 → 强制下一轮拉完整 Manifest 取远端真值 → 第二次提交成功收敛
// backoffMs 归零使退避可测；其余依赖保持真实。
import { describe, expect, it, vi } from "vitest";
import { ReconcileSession } from "../src/sync/session";
import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import type { BaseStore } from "../src/sync/base-store";
import type { PendingStore } from "../src/sync/pending-store";
import type { SnapshotRemote } from "../src/sync/remote";
import type { Snapshot } from "../src/sync/types";

vi.mock("../src/sync/utils", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../src/sync/utils")>();
	return { ...orig, backoffMs: () => 0 };
});

function fakeDeps(overrides: { commitSnapshot?: SnapshotRemote["commitSnapshot"] } = {}) {
	const base: Snapshot = {
		schema_version: 2,
		device_id: "dev-1",
		vault_id: "42",
		base_revision: "1",
		base_root_hash: "r1",
		entries: {},
	};
	const getBase = vi.fn(() => base as Snapshot | null);
	const localBuilder = new LocalSnapshotBuilder();
	return {
		deps: {
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
				// 强拉路径返回的完整 Manifest：远端真值（这里与 Base 声明的 root 一致，条目为空）
				getManifest: vi.fn(async () => ({ revision: 1n, rootHash: "r1", vaultId: "42", entries: {} })),
				getHead: vi.fn(),
				hasBlobs: vi.fn(async () => new Set<string>()),
				putBlob: vi.fn(async () => {}),
				getBlob: vi.fn(async () => new Uint8Array()),
				commitSnapshot: overrides.commitSnapshot ?? vi.fn(async () => null),
			} as unknown as SnapshotRemote,
			pluginDir: ".obsidian/plugins/pickpen",
			caseInsensitive: false,
			onStatus: vi.fn(),
		},
	};
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function waitForIdle(session: ReconcileSession): Promise<void> {
	for (let i = 0; i < 100 && session.isRunning(); i++) await tick();
}

describe("ReconcileSession 12018 自愈", () => {
	it("commit 抛 12018 → 强拉完整 Manifest 后重试一轮成功收敛", async () => {
		const commitSnapshot = vi
			.fn<SnapshotRemote["commitSnapshot"]>()
			.mockImplementationOnce(async () => {
				throw Object.assign(new Error("清单校验失败"), { code: 12018 });
			})
			.mockImplementationOnce(async () => ({ revision: 2n, rootHash: "r2", changed: true }));
		const { deps } = fakeDeps({ commitSnapshot });
		const session = new ReconcileSession(deps as never);
		const getManifest = deps.remote.getManifest as ReturnType<typeof vi.fn>;

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(commitSnapshot).toHaveBeenCalledTimes(2); // 失败一次 + 强拉后重试成功
		// 首轮走快路径（Head 未变，不拉 Manifest）；第二轮必须强拉一次取远端真值
		expect(getManifest).toHaveBeenCalledTimes(1);
		const onStatus = deps.onStatus as ReturnType<typeof vi.fn>;
		const last = onStatus.mock.calls[onStatus.mock.calls.length - 1]?.[0];
		expect(last.lastError).toBe("");
	});

	it("强拉后仍报 12018 → 不空转，按普通失败上报（每轮只强拉一次）", async () => {
		const commitSnapshot = vi.fn<SnapshotRemote["commitSnapshot"]>().mockImplementation(async () => {
			throw Object.assign(new Error("清单校验失败"), { code: 12018 });
		});
		const { deps } = fakeDeps({ commitSnapshot });
		const session = new ReconcileSession(deps as never);
		const getManifest = deps.remote.getManifest as ReturnType<typeof vi.fn>;

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(commitSnapshot).toHaveBeenCalledTimes(2); // 强拉那一轮仍失败即停，不再续跑
		expect(getManifest).toHaveBeenCalledTimes(1);
		const onStatus = deps.onStatus as ReturnType<typeof vi.fn>;
		const last = onStatus.mock.calls[onStatus.mock.calls.length - 1]?.[0];
		expect(last.lastError).toBe("同步失败：清单校验失败");
	});
});

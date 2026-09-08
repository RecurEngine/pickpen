// ReconcileSession 12023（file_id 身份冲突）恢复测试：
// - 第一次 commit 抛 12023 → session 自请求重对账（rerunRequested），不卡死
// - 第二次 commit 成功 → 收敛（lastError 清空）
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

describe("ReconcileSession 12023 恢复", () => {
	it("commit 抛 12023 → 自动重对账重试 → 第二次成功收敛", async () => {
		const commitSnapshot = vi
			.fn<SnapshotRemote["commitSnapshot"]>()
			.mockImplementationOnce(async () => {
				throw Object.assign(new Error("文件已被移动，请重新同步"), { code: 12023 });
			})
			.mockImplementationOnce(async () => ({ revision: 2n, rootHash: "r2", changed: true }));
		const { deps } = fakeDeps({ commitSnapshot });
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		// 12023 后 rerunRequested 自请求重对账 → 恰两次提交（失败一次 + 成功一次）
		expect(commitSnapshot).toHaveBeenCalledTimes(2);
		expect(session.isRunning()).toBe(false);
		// 最终收敛：状态回调无错误
		const onStatus = deps.onStatus as ReturnType<typeof vi.fn>;
		const last = onStatus.mock.calls[onStatus.mock.calls.length - 1]?.[0];
		expect(last.lastError).toBe("");
	});

	it("12025 设置容量已满状态，后续成功同步才清除", async () => {
		const commitSnapshot = vi
			.fn<SnapshotRemote["commitSnapshot"]>()
			.mockImplementationOnce(async () => {
				throw Object.assign(new Error("存储空间已达到当前套餐上限"), { code: 12025 });
			})
			.mockImplementationOnce(async () => ({ revision: 2n, rootHash: "r2", changed: true }));
		const { deps } = fakeDeps({ commitSnapshot });
		const session = new ReconcileSession(deps as never);
		const onStatus = deps.onStatus as ReturnType<typeof vi.fn>;

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);
		let last = onStatus.mock.calls[onStatus.mock.calls.length - 1]?.[0];
		expect(last.storageLimitExceeded).toBe(true);
		expect(last.storageLimitConfirmed).toBe(true);
		expect(last.lastError).toBe("云端存储已满，新改动暂时无法上传");

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);
		last = onStatus.mock.calls[onStatus.mock.calls.length - 1]?.[0];
		expect(last.storageLimitExceeded).toBe(false);
		expect(last.storageLimitConfirmed).toBe(false);
		expect(last.lastError).toBe("");
	});

	it("连续两次 12023 后抑制 rename hint 继承，第三次成功收敛（计划不再相同）", async () => {
		const commitSnapshot = vi
			.fn<SnapshotRemote["commitSnapshot"]>()
			.mockImplementationOnce(async () => {
				throw Object.assign(new Error("文件已被移动，请重新同步"), { code: 12023 });
			})
			.mockImplementationOnce(async () => {
				throw Object.assign(new Error("文件已被移动，请重新同步"), { code: 12023 });
			})
			.mockImplementationOnce(async () => ({ revision: 2n, rootHash: "r2", changed: true }));
		const { deps } = fakeDeps({ commitSnapshot });
		const session = new ReconcileSession(deps as never);

		session.requestRun({ forceAudit: true });
		await waitForIdle(session);

		expect(commitSnapshot).toHaveBeenCalledTimes(3); // 2 次失败 + 抑制 hint 后第 3 次成功
		expect(session.isRunning()).toBe(false);
		const onStatus = deps.onStatus as ReturnType<typeof vi.fn>;
		const last = onStatus.mock.calls[onStatus.mock.calls.length - 1]?.[0];
		expect(last.lastError).toBe("");
	});
});

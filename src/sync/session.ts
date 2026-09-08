// 统一 Reconcile Session（spec §9）：插件端只允许一个串行 Session 运行。
// 启动、切回前台、定时轮询和本地 dirty hint 都只负责 requestRun；并发请求不启动
// 第二个 Session，只设置 rerun_requested，当前 Session 结束后合并运行下一轮。
// 运行期间的新文件事件进入下一轮 dirty 集合，不混入本轮已取得快照的计划。

import { App, Platform, normalizePath } from "obsidian";

import { debugLog } from "../debug-log";
import { isFileIDMoved, isStorageLimitExceeded, isUnauthenticated } from "../remote-connect";
import type { PluginSettings } from "../types";
import { captureAllOpenViews, saveDirtyOpenViews, refreshOpenViews } from "../view-sync";
import { Applier } from "./applier";
import { BaseStore } from "./base-store";
import { LocalSnapshotBuilder } from "./local-snapshot";
import { buildTree } from "./merkle";
import { PendingStore } from "./pending-store";
import { plan } from "./planner";
import { SnapshotRemote } from "./remote";
import { KIND_DIR } from "./types";
import type { ApplyAction, Snapshot, SyncPlan } from "./types";
import { backoffMs, createYieldControl } from "./utils";

/** 12023 连续次数达此值 → 抑制 rename hint 继承（强制新身份，切断复发） */
const FILE_ID_MOVED_SUPPRESS_AFTER = 2;

export interface SyncStatus {
	running: boolean;
	lastError: string;
	blockedPaths: string[];
	storageLimitExceeded: boolean;
	/** 本轮确实收到 12025；用于跨日提醒前先向服务端确认，避免升级后的启动误报。 */
	storageLimitConfirmed: boolean;
	/** 全部同步完成：无运行、无错误、无阻塞、无 pending */
	allSynced: boolean;
}

export interface SessionDeps {
	app: App;
	getSettings: () => PluginSettings;
	baseStore: BaseStore;
	pendingStore: PendingStore;
	localBuilder: LocalSnapshotBuilder;
	remote: SnapshotRemote;
	pluginDir: string;
	caseInsensitive: boolean;
	initialStorageLimitExceeded?: boolean;
	onStatus?: (status: SyncStatus) => void;
}

export class ReconcileSession {
	private readonly deps: SessionDeps;
	private running = false;
	private rerunRequested = false;
	private forceAudit = false;
	private dirtyPaths = new Set<string>();
	private nextDirtyPaths = new Set<string>();
	/** 本轮 rename 提示（newPath → oldPath）：local-snapshot 据此继承 file_id */
	private renameHints = new Map<string, string>();
	private consecutiveFailures = 0;
	/** 12023 连续触发次数：驱动 hint 抑制与退避 */
	private fileIDMovedStreak = 0;
	/** 12023 连续触发后的 rename hint 抑制：fileIDFor 退化为新 UUID，保证重试产生不同 plan */
	private suppressRenameHints = false;
	private blockedPaths: string[] = [];
	private lastError = "";
	private storageLimitExceeded: boolean;
	private storageLimitConfirmed = false;
	private applier: Applier;

	constructor(deps: SessionDeps) {
		this.deps = deps;
		this.storageLimitExceeded = !!deps.initialStorageLimitExceeded;
		this.applier = new Applier(deps.app, deps.remote);
	}

	/** 唯一入口：dirty 提示 / 轮询发现 / 切前台 / 手动同步共用 */
	requestRun(opts?: { forceAudit?: boolean; dirtyPaths?: ReadonlySet<string> }): void {
		if (opts?.forceAudit) this.forceAudit = true;
		if (opts?.dirtyPaths) {
			for (const p of opts.dirtyPaths) this.nextDirtyPaths.add(p);
		}
		if (this.running) {
			this.rerunRequested = true;
			return;
		}
		void this.run();
	}

	isRunning(): boolean {
		return this.running;
	}

	getBlockedPaths(): string[] {
		return this.blockedPaths;
	}

	/** 换绑仓库：清内存状态 */
	reset(): void {
		this.dirtyPaths.clear();
		this.nextDirtyPaths.clear();
		this.blockedPaths = [];
		this.consecutiveFailures = 0;
		this.fileIDMovedStreak = 0;
		this.suppressRenameHints = false;
		this.lastError = "";
		this.storageLimitExceeded = false;
		this.deps.localBuilder.reset();
	}

	/** 本地 dirty 事件入口（local-hint 调用；运行中 → 下一轮） */
	addDirty(path: string): void {
		this.nextDirtyPaths.add(path);
	}

	/** rename 事件入口（local-hint 调用）：记录 new→old 映射并标脏两路径（保 file_id 身份） */
	addDirtyRename(oldPath: string, newPath: string): void {
		this.nextDirtyPaths.add(oldPath);
		this.nextDirtyPaths.add(newPath);
		this.renameHints.set(newPath, oldPath);
	}

	private get tmpDir(): string {
		return normalizePath(`${this.deps.pluginDir}/tmp`);
	}

	private report(): void {
		const pending = this.deps.pendingStore.getPending() !== null;
		const storageLimitConfirmed = this.storageLimitConfirmed;
		this.storageLimitConfirmed = false;
		this.deps.onStatus?.({
			running: this.running,
			lastError: this.lastError,
			blockedPaths: [...this.blockedPaths],
			storageLimitExceeded: this.storageLimitExceeded,
			storageLimitConfirmed,
			allSynced:
				!this.running && !this.lastError && !this.storageLimitExceeded && this.blockedPaths.length === 0 && !pending,
		});
	}

	private async run(): Promise<void> {
		this.running = true;
		this.report();
		try {
			do {
				this.rerunRequested = false;
				this.dirtyPaths = this.nextDirtyPaths;
				this.nextDirtyPaths = new Set();
				const force = this.forceAudit;
				this.forceAudit = false;
				try {
					await this.runOnce(force);
					// 只有一次无异常的同步轮次才能证明容量已经恢复。
					this.storageLimitExceeded = false;
				} catch (err) {
					if (isUnauthenticated(err)) {
						this.lastError = "令牌失效，请重新登录";
					} else if (isStorageLimitExceeded(err)) {
						this.storageLimitExceeded = true;
						this.storageLimitConfirmed = true;
						this.lastError = "云端存储已满，新改动暂时无法上传";
					} else {
						this.lastError = `同步失败：${(err as Error).message ?? String(err)}`;
						debugLog.error("[pickpen] Session 失败", err);
					}
					this.consecutiveFailures++;
				}
				await new Promise((r) => setTimeout(r, 0)); // 轮间让出事件循环
			} while (this.rerunRequested || this.nextDirtyPaths.size > 0);
		} finally {
			this.running = false;
			this.report();
		}
	}

	private async runOnce(forceAudit: boolean): Promise<void> {
		const { app, baseStore, pendingStore, localBuilder, remote } = this.deps;
		const settings = this.deps.getSettings();
		if (!settings.accessToken || !settings.vaultId) return;

		// 1. pending 恢复（§9.1 步骤 1 / §9.4）
		if (pendingStore.getPending()) {
			await this.recoverPending();
		}

		// 2. 保存打开视图中的未落盘编辑（§9.1 步骤 2，view-sync 复用）
		const views = await captureAllOpenViews(app);
		await saveDirtyOpenViews(app, views);

		// 3. 先取 Head，同时获得服务端按当前套餐下发的单文件上限。
		const base = baseStore.getBase();
		const knownRevision = base ? BigInt(base.base_revision) : 0n;
		const knownRoot = base?.base_root_hash ?? "";
		const head = await remote.pollHead(knownRevision, knownRoot);
		if (!head) return;
		const maxFileSizeBytes = Number(head.maxFileSizeBytes);
		if (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes <= 0) {
			throw new Error("服务端返回的单文件上限非法");
		}

		// 4. 消费本轮 dirty；按需完整审计，增量刷新 L。
		const localRes = await localBuilder.refresh({
			vault: app.vault,
			base,
			dirtyPaths: this.dirtyPaths,
			renameHints: this.suppressRenameHints ? undefined : this.renameHints, // 12023 抑制期不继承身份
			forceAudit,
			extraExcludes: settings.extraExcludes,
			caseInsensitive: this.deps.caseInsensitive,
			isMobile: Platform.isMobile,
			maxFileSizeBytes,
			yieldControl: createYieldControl(),
		});
		this.renameHints.clear(); // 本轮 hint 已消费
		const local = localRes.snapshot;
		this.blockedPaths = localRes.blockedPaths;

		// 5. Head 未变且 L == B → 结束（§9.1 步骤 5）
		const localTree = buildTree(local.entries);
		const localRoot = await localTree.rootHash;
		if (head.unchanged && base && localRoot === base.base_root_hash) {
			this.lastError = "";
			return;
		}

		// 6. 构建完整 R（Head 未变 → 服务端 root == Base root，用 Base entries 等价；
		//    Head 变 → GetManifest 下载完整 Manifest 并校验 root，§7.6）
		let remoteEntries: Record<string, import("./types").Entry>;
		if (head.unchanged && base) {
			remoteEntries = base.entries;
		} else {
			const manifest = await remote.getManifest(head.revision, head.rootHash);
			remoteEntries = manifest.entries;
		}
		const remoteSnap: Snapshot = {
			schema_version: 2,
			device_id: settings.deviceId,
			vault_id: settings.vaultId,
			base_revision: String(head.revision),
			base_root_hash: head.rootHash,
			entries: remoteEntries,
		};

		// 7. 三方对账（§9.1 步骤 7）
		const planResult = plan({
			base,
			local,
			remote: remoteSnap,
			deviceId: settings.deviceId,
			blockedPaths: this.blockedPaths,
		});
		planResult.target_root_hash = await (buildTree(planResult.target_entries)).rootHash;
		const hasWork =
			planResult.puts.length > 0 ||
			planResult.deletes.length > 0 ||
			planResult.apply_actions.length > 0 ||
			planResult.conflict_copies.length > 0;

		// 记录 Session 快照时的目标路径 hash（覆盖前用户改动检测）
		const expectedHashes = this.captureExpectedHashes(planResult, local);

		if (!hasWork) {
			// L 与 R 已一致（或仅 blocked 差异）：确认 Base 收敛
			if (localRoot !== base?.base_root_hash) {
				await baseStore.saveBase({
					schema_version: 2,
					device_id: settings.deviceId,
					vault_id: settings.vaultId,
					base_revision: String(head.revision),
					base_root_hash: head.rootHash,
					entries: planResult.target_entries,
				});
			}
			this.lastError = "";
			return;
		}

		// 8. 下载 Target 需要、本地尚无的 Remote Blob（§9.1 步骤 8）
		const downloads = planResult.apply_actions
			.filter((a) => a.kind === "write")
			.map((a) => ({ path: a.path, content_hash: a.content_hash, size: a.size }));
		const yc = createYieldControl();
		const tempContents = await this.applier.fetchBlobs(
			downloads,
			head.revision,
			head.rootHash,
			Platform.isMobile,
			yc,
		);
		for (const [hash, content] of tempContents) {
			await this.applier.writeTemp(app, normalizePath(`${this.tmpDir}/${hash}`), content);
		}
		for (const a of planResult.apply_actions) {
			if (a.kind === "write") a.temp_path = normalizePath(`${this.tmpDir}/${a.content_hash}`);
		}

		// 9. 提交前重新 stat/hash 复查（§9.1 步骤 9）：变化则放弃本轮，不应用已下载临时文件
		if (!(await this.verifyLocalUnchanged(planResult, expectedHashes))) {
			return;
		}

		// 10. PutBlob 预上传服务端缺失的内容 Blob（§9.1 步骤 10）
		const putHashes = new Map<string, string>(); // hash → 本地源路径
		for (const p of planResult.puts) if (p.content_hash) putHashes.set(p.content_hash, p.path); // dir 无内容，跳过
		for (const cc of planResult.conflict_copies) putHashes.set(cc.content_hash, cc.source_path);
		const existing = await remote.hasBlobs([...putHashes.keys()]);
		for (const [hash, srcPath] of putHashes) {
			if (existing.has(hash)) continue;
			const content = new Uint8Array(await app.vault.adapter.readBinary(srcPath));
			await remote.putBlob(hash, content);
		}

		// 11. 写 pending(prepared)——必须在 CommitSnapshot 之前落盘（§9.4）
		await pendingStore.writePrepared({
			schema_version: 2,
			vault_id: settings.vaultId,
			base_revision: base?.base_revision ?? "0",
			base_root_hash: base?.base_root_hash ?? "",
			target_root_hash: planResult.target_root_hash,
			apply_actions: planResult.apply_actions,
			created_at: new Date().toISOString(),
		});

		// 12. CAS 提交（§9.1 步骤 11 / §9.3）
		let commit: Awaited<ReturnType<SnapshotRemote["commitSnapshot"]>>;
		try {
			commit = await remote.commitSnapshot({
				expectedRevision: head.revision,
				expectedRootHash: head.rootHash,
				targetRootHash: planResult.target_root_hash,
				puts: planResult.puts,
				deletes: planResult.deletes,
			});
		} catch (err) {
			if (!isFileIDMoved(err)) throw err;
			// 12023：file_id 身份冲突。planner fix-up 后理论上不可达，此处为兜底
			// （历史脏数据双 active 同 file_id 时服务端对占用路径的裁决顺序不可复现、
			//  或本端 plan 回归缺陷）。回退本轮：不应用临时文件、不写 Base。
			this.fileIDMovedStreak++;
			if (this.fileIDMovedStreak >= FILE_ID_MOVED_SUPPRESS_AFTER) {
				// 抑制 hint：新路径不再继承被占用身份 → 强制新 UUID，重试产生不同 plan
				this.suppressRenameHints = true;
				this.renameHints.clear();
			}
			this.forceAudit = true; // 下一轮全量审计重对账（recoverPending 亦会清 pending + forceAudit）
			this.rerunRequested = true; // 12023 不改变服务端 Head，poller 不会触发新 Session → 必须自请求
			debugLog.warn(`[pickpen] CommitSnapshot 12023（file_id 身份冲突，第 ${this.fileIDMovedStreak} 次），退避后重新对账`);
			// 退避基数小（本地计划问题而非服务端争用，12015 才用 20s 基数）；指数上限 30s 防病态循环
			await new Promise((r) => setTimeout(r, backoffMs(this.fileIDMovedStreak, 2_000, 30_000)));
			return;
		}
		if (commit === null) {
			// SNAPSHOT_CHANGED：不应用临时文件、不写 Base、保留已上传 Blob，
			// 随机退避后从新 Head 重新对账（§9.3）
			await new Promise((r) => setTimeout(r, backoffMs(this.consecutiveFailures)));
			return;
		}
		this.consecutiveFailures = 0;
		this.fileIDMovedStreak = 0;
		this.suppressRenameHints = false;

		// 13. 逐文件安全写入本地（§9.1 步骤 12）
		await pendingStore.markCommitted(String(commit.revision));
		await pendingStore.markApplying();
		const skipped = await this.applier.applyPlan({
			actions: planResult.apply_actions,
			conflicts: planResult.conflict_copies,
			expectedHashes,
			expectedRevision: commit.revision,
			expectedRootHash: commit.rootHash,
			tmpDir: this.tmpDir,
			isMobile: Platform.isMobile,
			yieldControl: yc,
			onSkipped: (p) => this.nextDirtyPaths.add(p),
		});
		for (const p of skipped) this.nextDirtyPaths.add(p);
		await this.refreshViewsByDisk(app, views);

		// 14. 原子写新 Base（saveBase 内部重新 stat 记录实际落盘 mtime/size）→ 清 pending（§9.1 步骤 13/14）
		await baseStore.saveBase({
			schema_version: 2,
			device_id: settings.deviceId,
			vault_id: settings.vaultId,
			base_revision: String(commit.revision),
			base_root_hash: commit.rootHash,
			entries: planResult.target_entries,
		});
		await pendingStore.clear();
		await this.applier.cleanupTemp(this.tmpDir);
		this.lastError = "";
	}

	/** pending 恢复（§9.4）：Remote 与 pending target 一致 → 完成本地落地并更新 Base；
	 * 不一致 → 不盲目重放，清 pending 重新三方对账 */
	private async recoverPending(): Promise<void> {
		const { remote, pendingStore, baseStore } = this.deps;
		const settings = this.deps.getSettings();
		const pending = pendingStore.getPending();
		if (!pending || !settings.accessToken || !settings.vaultId) return;

		let head;
		try {
			head = await remote.getHead();
		} catch {
			return; // 网络失败：保留 pending，下次 Session 再试
		}
		if (!head) return;

		if (head.rootHash === pending.target_root_hash) {
			// Commit 已成功：完成本地落地并更新 Base
			try {
				const manifest = await remote.getManifest(head.revision, head.rootHash);
				await pendingStore.markApplying();
				await this.applier.applyPlan({
					actions: pending.apply_actions,
					conflicts: [],
					expectedHashes: new Map(),
					expectedRevision: head.revision,
					expectedRootHash: head.rootHash,
					tmpDir: this.tmpDir,
					isMobile: Platform.isMobile,
					yieldControl: createYieldControl(),
					onSkipped: (p) => this.nextDirtyPaths.add(p),
				});
				await baseStore.saveBase({
					schema_version: 2,
					device_id: settings.deviceId,
					vault_id: settings.vaultId,
					base_revision: String(head.revision),
					base_root_hash: head.rootHash,
					entries: manifest.entries,
				});
				await pendingStore.clear();
				this.forceAudit = true; // 落地后完整审计校正本地状态
				this.lastError = "";
			} catch (err) {
				debugLog.error("[pickpen] pending 恢复失败（保留 pending 重试）", err);
			}
			return;
		}
		// Remote 不一致：旧 apply_actions 作废，重新三方对账（本地内容不确定时由 planner 进冲突副本）
		await pendingStore.clear();
		this.forceAudit = true;
	}

	/** 记录 apply 目标路径在 Session 快照时的 hash（用户改动检测基线）。
	 * 必须取 Local 快照值而非重新读磁盘：读磁盘会把「快照之后、提交之前」的
	 * 用户写入当作基线，apply 阶段会误判「用户未改」而覆盖其修改 */
	private captureExpectedHashes(planResult: SyncPlan, local: Snapshot): Map<string, string> {
		const out = new Map<string, string>();
		for (const a of planResult.apply_actions) {
			if (a.kind === "mkdir" || a.kind === "rmdir") continue; // 目录无内容 hash
			const le = local.entries[a.path];
			if (le?.state === "active" && le.content_hash) {
				out.set(a.path, le.content_hash);
			}
			// L 中无该路径（或本地已删）：write 目标不存在可安全覆盖；trash 幂等
		}
		return out;
	}

	private async hashContent(content: ArrayBuffer): Promise<string> {
		const { sha256Hex } = await import("./content-hash");
		return sha256Hex(content);
	}

	/** 写盘后按路径分组刷新打开视图（磁盘内容即刚落盘的目标内容） */
	private async refreshViewsByDisk(app: App, views: Awaited<ReturnType<typeof captureAllOpenViews>>): Promise<void> {
		const byPath = new Map<string, typeof views>();
		for (const s of views) {
			const list = byPath.get(s.path);
			if (list) list.push(s);
			else byPath.set(s.path, [s]);
		}
		for (const [path, states] of byPath) {
			try {
				const content = new Uint8Array(await app.vault.adapter.readBinary(path));
				await refreshOpenViews(app, states, content);
			} catch {
				// 文件不存在：视图即将由 Obsidian 关闭，无需刷新
			}
		}
	}

	/** §9.1 步骤 9：提交前复查本地文件是否变化（变化则放弃本轮，不应用临时文件） */
	private async verifyLocalUnchanged(
		planResult: SyncPlan,
		expectedHashes: Map<string, string>,
	): Promise<boolean> {
		const { app } = this.deps;
		// puts：源内容必须仍是计划的 hash（dir 无内容，跳过）
		// 冲突副本 put 的 path 是待创建的副本路径（磁盘尚不存在），校验对象是其 source_path
		const conflictSources = new Map(planResult.conflict_copies.map((c) => [c.path, c.source_path]));
		for (const p of planResult.puts) {
			if (p.kind === KIND_DIR) continue;
			const srcPath = conflictSources.get(p.path) ?? p.path;
			try {
				const content = await app.vault.adapter.readBinary(srcPath);
				if ((await this.hashContent(content)) !== p.content_hash) return false;
			} catch {
				return false; // 源文件消失：放弃
			}
		}
		// deletes：目标路径在 Session 期间重现 → 放弃（下一轮对账）；
		// 目录删除目标做存在性检查（无内容 hash）
		for (const d of planResult.deletes) {
			const isDir = planResult.target_entries[d]?.kind === KIND_DIR;
			if (isDir) {
				if (await app.vault.adapter.exists(d)) return false;
				continue;
			}
			const expected = expectedHashes.get(d);
			try {
				const content = await app.vault.adapter.readBinary(d);
				const hash = await this.hashContent(content);
				if (expected === undefined || hash !== expected) return false;
			} catch {
				// 文件不存在（正常：delete 目标本应不存在）
			}
		}
		return true;
	}
}

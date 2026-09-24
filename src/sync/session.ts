// 统一 Reconcile Session（spec §9）：插件端只允许一个串行 Session 运行。
// 启动、切回前台、定时轮询和本地 dirty hint 都只负责 requestRun；并发请求不启动
// 第二个 Session，只设置 rerun_requested，当前 Session 结束后合并运行下一轮。
// 运行期间的新文件事件进入下一轮 dirty 集合，不混入本轮已取得快照的计划。

import { App, Platform, normalizePath } from "obsidian";

import { openForLocal, remoteHash, sealForRemote, vaultKeys } from "../crypto/vault-key-store";
import { debugLog } from "../debug-log";
import { isFileIDMoved, isStorageLimitExceeded, isUnauthenticated } from "../remote-connect";
import type { PluginSettings } from "../types";
import { captureAllOpenViews, saveDirtyOpenViews, refreshOpenViews } from "../view-sync";
import { ProgressTracker, type ProgressCallback, type SyncPhase, type SyncProgress } from "./progress";
import { Applier } from "./applier";
import { BaseStore } from "./base-store";
import { LocalSnapshotBuilder } from "./local-snapshot";
import { resolveConflictsByMerge, type MergePassResult } from "./merge-pass";
import { buildTree } from "./merkle";
import { PendingStore } from "./pending-store";
import { entriesEqual, isConflictCopyPath, plan } from "./planner";
import { SnapshotRemote } from "./remote";
import { createSyncFilter, type SyncFilter } from "./selective";
import { KIND_DIR, KIND_FILE } from "./types";
import type { Entry, Snapshot, SyncPlan } from "./types";
import { backoffMs, createYieldControl } from "./utils";

/** 12023 连续次数达此值 → 抑制 rename hint 继承（强制新身份，切断复发） */
const FILE_ID_MOVED_SUPPRESS_AFTER = 2;

/**
 * L 与 B 是否在「排除项之外」逐条一致。
 * 被排除路径不进 L（扫描时已过滤）却可能仍留在 B，直接比 root 会永远不相等；
 * 只有排除项之外的条目全部相等，才能安全跳过本轮（不写 Base、不动远端）。
 */
function sameEntriesExcept(
	filter: SyncFilter,
	local: Record<string, Entry>,
	base: Record<string, Entry>,
): boolean {
	const isDir = (e: Entry | undefined): boolean => (e?.kind ?? KIND_FILE) === KIND_DIR;
	for (const [path, be] of Object.entries(base)) {
		if (filter.isExcluded(path, isDir(be))) continue;
		if (!entriesEqual(local[path], be)) return false;
	}
	for (const [path, le] of Object.entries(local)) {
		if (filter.isExcluded(path, isDir(le))) continue;
		if (!(path in base)) return false;
	}
	return true;
}

/** vault 内全部文件路径。测试以最小 deps 直调私有方法时 vault 可能没有索引方法 */
function vaultPaths(app: App): string[] {
	const v = app.vault as unknown as { getFiles?: () => Array<{ path: string }> };
	return (v.getFiles?.() ?? []).map((f) => f.path);
}

export interface SyncStatus {
	progress: SyncProgress | null;
	running: boolean;
	lastError: string;
	blockedPaths: string[];
	/** 磁盘上待处理的冲突副本（存量）：仅提示，不参与 allSynced */
	conflictCopyPaths: string[];
	/** 「最后同步」时间戳（毫秒）；0 表示本次运行内还没有完成过一轮同步 */
	lastSyncAt: number;
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
	/** 同步前置检查：返回 false 表示本轮不能运行（如加密仓库尚未解锁）。
	 * interactive = 本轮由用户操作触发，允许弹出需要用户输入的提示 */
	preflight?: (interactive: boolean) => Promise<boolean>;
	pluginDir: string;
	/** 插件 id（manifest.id）：配置目录下同名插件目录（含自身同步状态文件）永不进入同步范围 */
	pluginId: string;
	caseInsensitive: boolean;
	initialStorageLimitExceeded?: boolean;
	/** 配置目录内的文件被写盘后的提示回调（宿主负责弹 Notice；不自动重载） */
	notifyConfigReload?: () => void;
	onStatus?: (status: SyncStatus) => void;
}

export class ReconcileSession {
	private readonly deps: SessionDeps;
	private running = false;
	private progress: SyncProgress | null = null;
	private progressVersion = 0;
	private rerunRequested = false;
	private forceAudit = false;
	/** 本轮强制重算全部寻址哈希（换成加密口径时用：磁盘没变但远端哈希整体变了） */
	private rehashAll = false;
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
	/** 待处理冲突副本存量（每轮扫描后刷新；仅提示用） */
	private conflictCopyPaths: string[] = [];
	private lastError = "";
	/** 「最后同步」时间：最近一轮无异常收尾的同步（仅供展示，不参与对账判定） */
	private lastSyncAt = 0;
	private storageLimitExceeded: boolean;
	private storageLimitConfirmed = false;
	/** 本轮是否由用户操作触发（决定能否弹出需要输入的提示） */
	private interactiveRequested = false;
	/** 手动同步等待者：整段同步空闲（含续跑）时统一 resolve，供调用方给用户回执 */
	private idleWaiters: Array<() => void> = [];
	private applier: Applier;
	/** 插件实例已卸载：在途轮次不再继续（卸载不会中断已启动的 Promise 链） */
	private disposed = false;

	constructor(deps: SessionDeps) {
		this.deps = deps;
		this.storageLimitExceeded = !!deps.initialStorageLimitExceeded;
		this.applier = new Applier(deps.app, deps.remote);
	}

	/**
	 * 卸载时调用：停止在途轮次并拒绝新轮次。旧实例若继续跑，会与新实例并发同步同一仓库，
	 * 还会继续消耗两边共享的 refresh token（见 AuthManager.dispose 的说明）。
	 */
	dispose(): void {
		this.disposed = true;
	}

	/** 唯一入口：dirty 提示 / 轮询发现 / 切前台 / 手动同步共用。
	 * interactive = 由用户操作触发（手动同步、绑定仓库、启动）：允许弹出需要用户输入的提示
	 * （如加密仓库的解锁窗）；后台轮询一律 false，避免打断编辑。 */
	requestRun(opts?: {
		forceAudit?: boolean;
		rehashAll?: boolean;
		dirtyPaths?: ReadonlySet<string>;
		interactive?: boolean;
	}): void {
		if (this.disposed) return;
		if (opts?.forceAudit) this.forceAudit = true;
		if (opts?.rehashAll) this.rehashAll = true;
		if (opts?.interactive) this.interactiveRequested = true;
		if (opts?.dirtyPaths) {
			for (const p of opts.dirtyPaths) this.nextDirtyPaths.add(p);
		}
		if (this.running) {
			this.rerunRequested = true;
			return;
		}
		void this.run();
	}

	/**
	 * 用户主动同步（Ribbon / 「立即同步」命令）：返回「这一整段同步跑完」的 Promise，
	 * 调用方据此给出结果回执；已有轮在跑时返回 null（本次并入下一轮，不新开 Session，
	 * 与 requestRun 的合并语义一致）。
	 */
	requestManualRun(): Promise<void> | null {
		if (this.disposed) return null;
		if (this.running) {
			this.rerunRequested = true;
			return null;
		}
		this.interactiveRequested = true; // 加密仓库照常弹解锁窗
		const idle = new Promise<void>((resolve) => this.idleWaiters.push(resolve));
		void this.run();
		return idle;
	}

	isRunning(): boolean {
		return this.running;
	}

	getBlockedPaths(): string[] {
		return this.blockedPaths;
	}

	/** 换绑仓库：清内存状态 */
	reset(): void {
		this.clearProgress();
		this.dirtyPaths.clear();
		this.nextDirtyPaths.clear();
		this.blockedPaths = [];
		this.consecutiveFailures = 0;
		this.fileIDMovedStreak = 0;
		this.suppressRenameHints = false;
		this.lastError = "";
		this.lastSyncAt = 0; // 换绑后旧仓库的「最后同步」不再适用
		this.storageLimitExceeded = false;
		this.deps.localBuilder.reset();
		this.report();
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

	private clearProgress(): void {
		this.progressVersion++;
		this.progress = null;
	}

	private beginPhase(phase: SyncPhase): ProgressCallback {
		const version = ++this.progressVersion;
		this.progress = { phase, completed: 0, total: null, activePaths: [] };
		this.report();
		return (update) => {
			if (!this.running || version !== this.progressVersion) return;
			this.progress = { phase, ...update };
			this.report();
		};
	}

	private report(): void {
		const pending = this.deps.pendingStore.getPending() !== null;
		const storageLimitConfirmed = this.storageLimitConfirmed;
		this.storageLimitConfirmed = false;
		this.deps.onStatus?.({
			running: this.running,
			progress: this.progress,
			lastError: this.lastError,
			blockedPaths: [...this.blockedPaths],
			conflictCopyPaths: [...this.conflictCopyPaths],
			lastSyncAt: this.lastSyncAt,
			storageLimitExceeded: this.storageLimitExceeded,
			storageLimitConfirmed,
			allSynced:
				!this.running && !this.lastError && !this.storageLimitExceeded && this.blockedPaths.length === 0 && !pending,
		});
	}

	/**
	 * 一轮同步无异常收尾：清错误并记下「最后同步」时间。
	 * 只在真正跑完一轮的对账收尾点调用——未登录/未绑定的守卫返回、本轮放弃（本地文件已变）
	 * 与 12015/12023 退避重试都不算同步过，不更新时间戳。
	 */
	private finishRound(): void {
		this.lastError = "";
		this.lastSyncAt = Date.now();
	}

	private async run(): Promise<void> {
		this.running = true;
		this.report();
		try {
			do {
				if (this.disposed) return; // 已卸载：不再开启新一轮（finally 仍会收尾上报）
				this.beginPhase("preparing");
				this.rerunRequested = false;
				this.dirtyPaths = this.nextDirtyPaths;
				this.nextDirtyPaths = new Set();
				const force = this.forceAudit;
				this.forceAudit = false;
				const interactive = this.interactiveRequested;
				this.interactiveRequested = false;
				// 内容寻址代次与基线不一致（明文转加密、别处换了密钥）→ 本轮重算全部寻址哈希。
				// 判定依据落盘在 Base 里，因此转换中途失败/关闭 Obsidian 后重开依然会重算，
				// 不会留下「仓库已标记为加密、内容却还是明文」的状态。
				const rehashAll = this.rehashAll || this.baseEpochStale();
				this.rehashAll = false;
				try {
					await this.runOnce(force, interactive, rehashAll);
					// 只有一次无异常的同步轮次才能证明容量已经恢复。
					this.storageLimitExceeded = false;
				} catch (err) {
					this.clearProgress();
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
					// 不在此处 report：storageLimitConfirmed 是一次性标志，在 report 内被消费，
					// 多报一次会让随后的 finally 上报把它冲掉。循环继续时下一轮 beginPhase
					// 立即带出错误，循环结束则 finally 上报，两种路径都不会漏。
				}
				await new Promise((r) => window.setTimeout(r, 0)); // 轮间让出事件循环
			} while (!this.disposed && (this.rerunRequested || this.nextDirtyPaths.size > 0));
		} finally {
			this.running = false;
			this.clearProgress();
			this.report();
			// 整段同步（当前轮 + 已排队的续跑）结束：叫醒手动同步的等待者
			const waiters = this.idleWaiters;
			this.idleWaiters = [];
			for (const resolve of waiters) resolve();
		}
	}

	/** Base 记录的内容密钥代次与当前代次是否不一致（不一致 = 必须重算全部寻址哈希） */
	private baseEpochStale(): boolean {
		const base = this.deps.baseStore.getBase();
		if (!base) return false; // 无 Base 时全量扫描本就会重算
		return (base.key_epoch ?? "") !== vaultKeys.getEpoch();
	}

	/** 建本轮的选择性同步过滤（同一批次内只建一次，扫描与对账共用） */
	private buildFilter(settings: PluginSettings): SyncFilter {
		return createSyncFilter({
			selective: settings.selective,
			configDir: this.deps.app.vault.configDir,
			selfDir: this.deps.pluginDir,
			selfId: this.deps.pluginId,
		});
	}

	private async runOnce(forceAudit: boolean, interactive: boolean, rehashAll: boolean): Promise<void> {
		const { app, baseStore, pendingStore, localBuilder, remote } = this.deps;
		const settings = this.deps.getSettings();
		if (!settings.accessToken || !settings.vaultId) return;

		// 本轮的选择性同步过滤：扫描与对账必须共用同一实例，否则中途改设置会让两侧口径错位
		const filter = this.buildFilter(settings);

		// 0. 同步前置检查（加密仓库未解锁时不能读盘算哈希，本轮整体不运行）
		if (this.deps.preflight && !(await this.deps.preflight(interactive))) return;
		if (this.disposed) return; // 已卸载：前置检查期间被卸载则不再继续

		// 1. pending 恢复（§9.1 步骤 1 / §9.4）
		if (pendingStore.getPending()) {
			await this.recoverPending();
		}

		// 2. 保存打开视图中的未落盘编辑（§9.1 步骤 2，view-sync 复用）
		this.beginPhase("preparing");
		const views = await captureAllOpenViews(app);
		await saveDirtyOpenViews(app, views);

		// 3. 先取 Head，同时获得服务端按当前套餐下发的单文件上限。
		const base = baseStore.getBase();
		const knownRevision = base ? BigInt(base.base_revision) : 0n;
		const knownRoot = base?.base_root_hash ?? "";
		this.beginPhase("remote");
		const head = await remote.pollHead(knownRevision, knownRoot);
		if (!head) return;
		const maxFileSizeBytes = Number(head.maxFileSizeBytes);
		if (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes <= 0) {
			throw new Error("服务端返回的单文件上限非法");
		}

		// 4. 消费本轮 dirty；按需完整审计，增量刷新 L。
		const scanProgress = this.beginPhase("scanning");
		const localRes = await localBuilder.refresh({
			onProgress: scanProgress,
			vault: app.vault,
			base,
			dirtyPaths: this.dirtyPaths,
			renameHints: this.suppressRenameHints ? undefined : this.renameHints, // 12023 抑制期不继承身份
			forceAudit,
			rehashAll,
			filter,
			caseInsensitive: this.deps.caseInsensitive,
			isMobile: Platform.isMobile,
			maxFileSizeBytes,
			yieldControl: createYieldControl(),
		});
		this.renameHints.clear(); // 本轮 hint 已消费
		const local = localRes.snapshot;
		this.blockedPaths = localRes.blockedPaths;
		// 冲突副本存量：取自 vault 索引而非同步快照——被排除/被阻塞的路径也要计入，
		// 用户是在文件列表里看到它们、并从这里去处理的（配置目录内的副本不进 vault 索引，不计）
		this.conflictCopyPaths = vaultPaths(app).filter(isConflictCopyPath);

		// 5. Head 未变且 L == B → 结束（§9.1 步骤 5）。
		// 被排除路径不进 L（扫描时已过滤）而可能仍留在 B，直接比 root 会永远不相等：
		// 改用「排除项之外逐条一致」的等价判定，避免每轮都白跑一次全量 plan + saveBase
		this.beginPhase("planning");
		const localTree = buildTree(local.entries);
		const localRoot = await localTree.rootHash;
		if (head.unchanged && base && (localRoot === base.base_root_hash || sameEntriesExcept(filter, local.entries, base.entries))) {
			this.finishRound(); // 无变化的空轮次也是一次完成的同步
			return;
		}

		// 6. 构建完整 R（Head 未变 → 服务端 root == Base root，用 Base entries 等价；
		//    Head 变 → GetManifest 下载完整 Manifest 并校验 root，§7.6）
		let remoteEntries: Record<string, import("./types").Entry>;
		if (head.unchanged && base) {
			remoteEntries = base.entries;
		} else {
			this.beginPhase("remote");
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
		this.beginPhase("planning");
		const planResult = plan({
			base,
			local,
			remote: remoteSnap,
			deviceId: settings.deviceId,
			blockedPaths: this.blockedPaths,
			filter,
		});
		// 7b. 内容级合并（§8.2 扩展）：把能在内容层干净合并的冲突副本就地消解。
		// 必须早于 target_root_hash 计算与 expectedHashes 采集——两者都读改写后的 plan
		const mergePass = await this.runMergePass({
			plan: planResult,
			base,
			remote: remoteSnap,
			filter,
			expectedRevision: head.revision,
			expectedRootHash: head.rootHash,
		});
		planResult.target_root_hash = await (buildTree(planResult.target_entries)).rootHash;
		const hasWork =
			planResult.puts.length > 0 ||
			planResult.deletes.length > 0 ||
			planResult.apply_actions.length > 0 ||
			planResult.conflict_copies.length > 0;

		// 记录 Session 快照时的目标路径 hash（覆盖前用户改动检测）
		const expectedHashes = this.captureExpectedHashes(planResult, local);

		// 本轮未校验过磁盘内容的路径（被排除 / 被阻塞）：Base 不得为其记 local_* 快路径字段，
		// 否则下一轮快路径会拿旧 hash 冒充实测值，把期间的本地改动永久漏掉
		const blockedNow = new Set(this.blockedPaths);
		const unverified = (path: string): boolean => {
			if (blockedNow.has(path)) return true;
			const e = planResult.target_entries[path];
			return filter.isExcluded(path, (e?.kind ?? KIND_FILE) === KIND_DIR);
		};

		if (!hasWork) {
			// L 与 R 已一致（或仅 blocked 差异）：确认 Base 收敛
			if (localRoot !== base?.base_root_hash) {
				this.beginPhase("finishing");
				await baseStore.saveBase({
					schema_version: 2,
					device_id: settings.deviceId,
					vault_id: settings.vaultId,
					base_revision: String(head.revision),
					base_root_hash: head.rootHash,
					entries: planResult.target_entries,
				}, unverified);
			}
			this.finishRound();
			return;
		}

		// 8. 下载 Target 需要、本地尚无的 Remote Blob（§9.1 步骤 8）：下载即写插件私有临时区，
		//    计数到齐即临时区就绪（避免「已完成 N/N 却仍在写盘」）
		// 合并产物已在临时区就绪（服务端尚未有该内容），不走下载
		const downloads = planResult.apply_actions
			.filter((a) => a.kind === "write" && !mergePass.stagedHashes.has(a.content_hash))
			.map((a) => ({ path: a.path, content_hash: a.content_hash, size: a.size }));
		const yc = createYieldControl();
		await this.applier.fetchBlobs(
			downloads,
			head.revision,
			head.rootHash,
			Platform.isMobile,
			yc,
			this.beginPhase("downloading"),
			this.tmpDir,
		);
		for (const a of planResult.apply_actions) {
			if (a.kind === "write") a.temp_path = normalizePath(`${this.tmpDir}/${a.content_hash}`);
		}

		// 9. 提交前重新 stat/hash 复查（§9.1 步骤 9）：变化则放弃本轮，不应用已下载临时文件
		if (!(await this.verifyLocalUnchanged(planResult, expectedHashes, mergePass.mergedPaths, this.beginPhase("verifying")))) {
			return;
		}

		// 10. PutBlob 预上传服务端缺失的内容 Blob（§9.1 步骤 10）
		const putHashes = new Map<string, string>(); // hash → 本地源路径
		for (const p of planResult.puts) if (p.content_hash) putHashes.set(p.content_hash, p.path); // dir 无内容，跳过
		// 冲突副本预上传：配置文件（配置目录内）的副本只落本地、不进 target（见 planner），
		// 白传一次 Blob 没有意义
		for (const cc of planResult.conflict_copies) {
			if (filter.isConfigPath(cc.path)) continue;
			putHashes.set(cc.content_hash, cc.source_path);
		}
		const uploadProgress = this.beginPhase("uploading");
		const existing = await remote.hasBlobs([...putHashes.keys()]);
		const uploads = [...putHashes].filter(([hash]) => !existing.has(hash));
		const uploadTracker = new ProgressTracker(uploads.length, uploadProgress);
		for (const [hash, srcPath] of uploads) {
			await uploadTracker.track(srcPath, async () => {
				if (mergePass.stagedHashes.has(hash)) {
					// 合并产物：临时区里已是「密封后」的字节（其 SHA-256 即计划声明的 hash）。
					// 绝不能按源文件重新密封——磁盘上仍是合并前的本地内容，会算出另一个地址
					const sealedBytes = new Uint8Array(
						await app.vault.adapter.readBinary(normalizePath(`${this.tmpDir}/${hash}`)),
					);
					await remote.putBlob(hash, sealedBytes);
					return;
				}
				const content = new Uint8Array(await app.vault.adapter.readBinary(srcPath));
				// 上传统一出口：加密仓库在这里转成密文。
				// 声明哈希用计划里的 hash 而不是重算值：文件若在上传期间被改动，服务端重算
				// SHA-256 会当场以 12006 拒绝，而不是把内容存到一个没人引用的新地址上
				const sealed = await sealForRemote(content);
				await remote.putBlob(hash, sealed.bytes);
			});
		}

		// 11. 写 pending(prepared)——必须在 CommitSnapshot 之前落盘（§9.4）
		this.beginPhase("committing");
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
			this.beginPhase("waiting");
			await new Promise((r) => window.setTimeout(r, backoffMs(this.fileIDMovedStreak, 2_000, 30_000)));
			return;
		}
		if (commit === null) {
			// SNAPSHOT_CHANGED：不应用临时文件、不写 Base、保留已上传 Blob，
			// 随机退避后从新 Head 重新对账（§9.3）
			this.beginPhase("waiting");
			await new Promise((r) => window.setTimeout(r, backoffMs(this.consecutiveFailures)));
			return;
		}
		this.consecutiveFailures = 0;
		this.fileIDMovedStreak = 0;
		this.suppressRenameHints = false;

		// 13. 逐文件安全写入本地（§9.1 步骤 12）
		await pendingStore.markCommitted(String(commit.revision));
		await pendingStore.markApplying();
		const skipped = await this.applier.applyPlan({
			onProgress: this.beginPhase("applying"),
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
		this.beginPhase("finishing");
		await this.refreshViewsByDisk(app, views);
		// 配置文件写盘不会热生效（宿主在内存里持有设置、部分配置要重载才读盘）：
		// 只提示，不自动重载（重载会打断用户正在做的事）
		if ([...planResult.apply_actions, ...planResult.conflict_copies].some((a) => filter.isConfigPath(a.path))) {
			this.deps.notifyConfigReload?.();
		}

		// 14. 原子写新 Base（saveBase 内部重新 stat 记录实际落盘 mtime/size）→ 清 pending（§9.1 步骤 13/14）。
		// 被跳过的路径（用户期间改过）不算已校验：它们的 local_* 由下一轮 dirty 刷新补齐
		const skippedSet = new Set(skipped);
		await baseStore.saveBase({
			schema_version: 2,
			device_id: settings.deviceId,
			vault_id: settings.vaultId,
			base_revision: String(commit.revision),
			base_root_hash: commit.rootHash,
			entries: planResult.target_entries,
		}, (path) => skippedSet.has(path) || unverified(path));
		await pendingStore.clear();
		await this.applier.cleanupTemp(this.tmpDir);
		this.finishRound();
	}

	/** pending 恢复（§9.4）：Remote 与 pending target 一致 → 完成本地落地并更新 Base；
	 * 不一致 → 不盲目重放，清 pending 重新三方对账 */
	private async recoverPending(): Promise<void> {
		const { remote, pendingStore, baseStore } = this.deps;
		const settings = this.deps.getSettings();
		const pending = pendingStore.getPending();
		if (!pending || !settings.accessToken || !settings.vaultId) return;

		this.beginPhase("recovering");
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
				const filter = this.buildFilter(settings);
				const skippedPaths = new Set<string>();
				await pendingStore.markApplying();
				await this.applier.applyPlan({
					onProgress: this.beginPhase("applying"),
					actions: pending.apply_actions,
					conflicts: [],
					expectedHashes: new Map(),
					expectedRevision: head.revision,
					expectedRootHash: head.rootHash,
					tmpDir: this.tmpDir,
					isMobile: Platform.isMobile,
					yieldControl: createYieldControl(),
					onSkipped: (p) => {
						skippedPaths.add(p);
						this.nextDirtyPaths.add(p);
					},
				});
				this.beginPhase("finishing");
				await baseStore.saveBase({
					schema_version: 2,
					device_id: settings.deviceId,
					vault_id: settings.vaultId,
					base_revision: String(head.revision),
					base_root_hash: head.rootHash,
					entries: manifest.entries,
				}, (path) => {
					if (skippedPaths.has(path)) return true;
					const e = manifest.entries[path];
					return filter.isExcluded(path, (e?.kind ?? KIND_FILE) === KIND_DIR);
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

	/**
	 * 内容级合并（spec §8.2 扩展）：对 planner 产出的冲突副本逐个尝试 Base/Local/Remote
	 * 三方合并，能干净合并的路径直接从 plan 中消解——原路径落合并结果，不再产生副本。
	 * 任何一步失败都降级为保留冲突副本，不中断本轮。
	 */
	private async runMergePass(args: {
		plan: SyncPlan;
		base: Snapshot | null;
		remote: Snapshot;
		filter: SyncFilter;
		expectedRevision: bigint;
		expectedRootHash: string;
	}): Promise<MergePassResult> {
		if (args.plan.conflict_copies.length === 0) {
			return { mergedPaths: new Set(), stagedHashes: new Set() };
		}
		const { app, remote } = this.deps;
		return resolveConflictsByMerge({
			plan: args.plan,
			base: args.base,
			remote: args.remote,
			isConfigPath: (path) => args.filter.isConfigPath(path),
			deps: {
				readLocal: async (path) => new Uint8Array(await app.vault.adapter.readBinary(path)),
				// Base 版本走历史通道（history_file_id 非空即免 expected Head 校验），
				// 因此这里不传 Head；转换加密前遗留的明文历史版本允许按明文读回
				readBase: async (hash, fileId) => openForLocal(await remote.getBlob(hash, 0n, "", fileId), true),
				readRemote: async (hash) =>
					openForLocal(await remote.getBlob(hash, args.expectedRevision, args.expectedRootHash)),
				seal: async (content) => {
					const sealed = await sealForRemote(content);
					return { hash: sealed.hash, bytes: sealed.bytes };
				},
				// 与下载产物同一临时区布局：后续 temp_path 推导与 applier 读取都无需特殊处理
				stage: async (hash, bytes) =>
					this.applier.writeTemp(app, normalizePath(`${this.tmpDir}/${hash}`), bytes),
				onNote: (path, message) => debugLog.info(`[pickpen] 内容合并 ${path}：${message}`),
			},
		});
	}

	/** 本地内容的远端寻址哈希：加密仓库为密文哈希（与提交给服务端的一致） */
	private async hashContent(content: ArrayBuffer): Promise<string> {
		return remoteHash(content);
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
		mergedPaths: Set<string>,
		onProgress: ProgressCallback,
	): Promise<boolean> {
		const { app } = this.deps;
		// puts：源内容必须仍是计划的 hash（dir 无内容，跳过）
		// 冲突副本 put 的 path 是待创建的副本路径（磁盘尚不存在），校验对象是其 source_path
		const conflictSources = new Map(planResult.conflict_copies.map((c) => [c.path, c.source_path]));
		const filePuts = planResult.puts.filter((p) => p.kind !== KIND_DIR);
		const tracker = new ProgressTracker(filePuts.length + planResult.deletes.length, onProgress);
		for (const p of filePuts) {
			const srcPath = conflictSources.get(p.path) ?? p.path;
			const finish = tracker.start(srcPath);
			let verified = false;
			try {
				const content = await app.vault.adapter.readBinary(srcPath);
				// 内容级合并产出的 put：磁盘上仍是合并前的本地内容，put 的 hash 是合并结果，
				// 二者本就不等——这里要校验的是「用户没在提交前改动」，基线取 Session 快照时的
				// 本地 hash（合并结果与本地一致时无写动作、也就没有基线，退回按 put hash 比对）
				const expected = mergedPaths.has(p.path)
					? (expectedHashes.get(p.path) ?? p.content_hash)
					: p.content_hash;
				if ((await this.hashContent(content)) !== expected) return false;
				verified = true;
			} catch {
				return false; // 源文件消失：放弃
			} finally {
				finish(verified); // 放弃路径同样清掉活动路径：不虚增完成数、不留残留
			}
		}
		// deletes：目标路径在 Session 期间重现 → 放弃（下一轮对账）；
		// 目录删除目标做存在性检查（无内容 hash）
		for (const d of planResult.deletes) {
			const finish = tracker.start(d);
			let processed = false;
			try {
				if (planResult.target_entries[d]?.kind === KIND_DIR) {
					if (await app.vault.adapter.exists(d)) return false; // 读盘异常照旧向上抛
				} else {
					const expected = expectedHashes.get(d);
					try {
						const content = await app.vault.adapter.readBinary(d);
						const hash = await this.hashContent(content);
						if (expected === undefined || hash !== expected) return false;
					} catch {
						// 文件不存在（正常：delete 目标本应不存在）
					}
				}
				processed = true;
			} finally {
				finish(processed);
			}
		}
		return true;
	}
}

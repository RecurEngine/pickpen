// Local Snapshot 构建（spec §9.2）：dirty 增量刷新 + 完整审计 + Base 合成。
// - 普通文件事件只 stat/hash dirty 路径；force_audit 才枚举全部同步范围文件
// - TFile.stat 优先（Obsidian 已维护），不默认调用 adapter.stat
// - mtime+size 与 Base 一致 → 快路径跳过（不读内容）
// - §7.5 本地删除状态构造（Base active 缺失 → deleted；Base deleted 保持/重现）
// - 超限/读取失败的路径 → blocked，不得生成 deleted（§9.2 规则 5）
// - 大小写不敏感平台的大小写冲突路径 → blocked（§16.5）
// - 目录条目物化（统一规则）：磁盘存在的目录（未被排除）一律物化 active dir entry
//   （目录与文件同构；rename/删除以 dir 行 tombstone 传播，spec §7.1 dir+children 合法）
// - file_id：Base 复用 → renameHints 继承 → 新生成 UUID（rename 保身份）
// - 选择性同步（选择性同步过滤，sync/selective.ts）：排除项由 filter 统一判定；
//   被排除路径既不进 entries，也不在 §7.5 里合成删除（否则会伪造成远端删除）
// - 配置文件（配置目录不在 vault 索引里）：经 filter.scanConfigFiles + adapter 枚举与读写

import { TFolder, type TFile, type Vault } from "obsidian";

import { debugLog } from "../debug-log";
import { ProgressTracker, type ProgressCallback } from "./progress";
import { isTooBig, normalize } from "../excludes";
import type { SyncFilter } from "./selective";
import { nfcPath, detectCaseConflicts } from "./path";
import { remoteHash } from "../crypto/vault-key-store";
import { KIND_DIR, KIND_FILE } from "./types";
import type { Entry, Snapshot } from "./types";
import { createYieldControl, mapConcurrent, newUUID, type YieldControl } from "./utils";

export interface LocalScanContext {
	vault: Vault;
	base: Snapshot | null;
	/** 本轮 dirty 路径（增量模式）；null/undefined = 无 dirty（跳过增量） */
	dirtyPaths?: ReadonlySet<string>;
	/** rename 提示（newPath → oldPath），用于继承 file_id 保 rename 身份 */
	renameHints?: Map<string, string>;
	forceAudit: boolean;
	/** 强制重算全部内容的寻址哈希，跳过 mtime+size 快路径。
	 * 用于换了加密口径的场景（明文仓库转加密）：磁盘文件没变，但远端寻址哈希整体变了。 */
	rehashAll?: boolean;
	/** 选择性同步过滤（排除清单 + 类型/配置分类）；扫描与对账必须共用同一实例 */
	filter: SyncFilter;
	/** 大小写不敏感平台（Platform.isDesktopApp 为 false 或运行时探测） */
	caseInsensitive: boolean;
	/** 桌面/移动端并发参数（spec §10.1） */
	isMobile: boolean;
	/** 服务端按当前套餐下发的单文件上限。 */
	maxFileSizeBytes: number;
	yieldControl?: YieldControl;
	onProgress?: ProgressCallback;
}

export interface LocalScanResult {
	snapshot: Snapshot;
	blockedPaths: string[];
}

/** hash 并发：移动端 1、桌面端 4（spec §10.1） */
const HASH_CONCURRENCY = { desktop: 4, mobile: 1 } as const;

/** 配置文件 sweep 间隔：配置文件不进 vault 索引、不产生 vault 事件，只能靠周期 stat 发现外部改动 */
const CONFIG_SWEEP_MS = 30_000;

export class LocalSnapshotBuilder {
	/** 内存当前 Local（dirty 增量在其上打补丁；force_audit 全量重建） */
	private current: Snapshot | null = null;
	private blockedPaths = new Set<string>();
	/** 上次配置 sweep 时刻（节流用；移动端 adapter.stat 走桥，避免每轮都扫） */
	private lastConfigSweepAt = 0;

	getCurrent(): Snapshot | null {
		return this.current;
	}

	/** 换绑仓库后清空内存状态 */
	reset(): void {
		this.current = null;
		this.blockedPaths.clear();
		this.lastConfigSweepAt = 0;
	}

	/**
	 * 刷新 Local Snapshot。
	 * force_audit：全量枚举重建；否则仅消费 dirtyPaths + 配置 sweep（dirty 为空且已有 current 时直接返回）。
	 */
	async refresh(ctx: LocalScanContext): Promise<LocalScanResult> {
		const yieldCtl = ctx.yieldControl ?? createYieldControl();
		if (!this.current) {
			// 冷启动：以 Base（若有）为骨架，等 force_audit 校正
			this.current = ctx.base ? cloneSnapshot(ctx.base) : emptyLocal(ctx.base);
		}
		if (!ctx.forceAudit) {
			// 配置 sweep 先于「无 dirty 直接返回」：否则设置改动要等 15min 周期对账才会被发现
			const swept = await this.sweepConfigFiles(ctx);
			if (swept.size > 0) {
				ctx = { ...ctx, dirtyPaths: new Set([...(ctx.dirtyPaths ?? []), ...swept]) };
			}
		}
		if (!ctx.forceAudit && (!ctx.dirtyPaths || ctx.dirtyPaths.size === 0)) {
			return { snapshot: this.current, blockedPaths: [...this.blockedPaths] };
		}

		let blocked: string[] = [];
		if (ctx.forceAudit) {
			blocked = await this.fullAudit(ctx, yieldCtl);
			this.blockedPaths = new Set(blocked);
		} else {
			for (const rawPath of ctx.dirtyPaths ?? []) {
				const path = nfcPath(normalize(rawPath));
				if (path !== null) this.blockedPaths.delete(path);
			}
			blocked = await this.applyDirty(ctx, yieldCtl);
			for (const path of blocked) this.blockedPaths.add(path);
		}
		return { snapshot: this.current, blockedPaths: [...this.blockedPaths] };
	}

	/**
	 * 配置 sweep：对已启用分类的配置文件做一轮 stat，把「与 Base 的 mtime+size 不一致」「Base 无记录」
	 * 「Base 有但磁盘已无」的路径返回为 dirty（由 refreshConfigPath 完成哈希与删除判定）。
	 * 按 CONFIG_SWEEP_MS 节流：这是纯增量轮次的额外 I/O，不值得每轮都付。
	 */
	private async sweepConfigFiles(ctx: LocalScanContext): Promise<Set<string>> {
		const out = new Set<string>();
		if (!ctx.filter.configEnabled()) return out;
		const now = Date.now();
		if (now - this.lastConfigSweepAt < CONFIG_SWEEP_MS) return out;
		this.lastConfigSweepAt = now;
		for (const path of await ctx.filter.scanConfigFiles(ctx.vault.adapter)) {
			const be = ctx.base?.entries[path];
			let stat: { mtime: number; size: number } | null = null;
			try {
				stat = await ctx.vault.adapter.stat(path);
			} catch {
				stat = null;
			}
			// 枚举后被删：仍交给 refreshConfigPath 判定（Base 有则记为删除）
			if (!stat) {
				if (be) out.add(path);
				continue;
			}
			if (
				!be ||
				be.state !== "active" ||
				be.local_mtime !== String(stat.mtime) ||
				be.local_size !== String(stat.size)
			) {
				out.add(path);
			}
		}
		return out;
	}

	/** 完整审计：枚举全部同步范围文件/目录 + §7.5 删除状态构造（spec §9.2 规则 1-5） */
	private async fullAudit(ctx: LocalScanContext, yieldCtl: YieldControl): Promise<string[]> {
		const files = ctx.vault.getFiles();
		const disk = new Map<string, TFile>();
		const hashConcurrency = HASH_CONCURRENCY[ctx.isMobile ? "mobile" : "desktop"];

		// 1. 过滤排除/超限，收集有效路径（TFile.stat 同步，无 Adapter I/O）
		const oversized: string[] = [];
		for (const f of files) {
			await yieldCtl.tick(100, 50);
			const path = normalize(f.path);
			if (ctx.filter.isExcluded(path)) continue;
			const stat = f.stat;
			if (stat && isTooBig(stat.size, ctx.maxFileSizeBytes)) {
				oversized.push(path);
				continue;
			}
			disk.set(path, f);
		}
		// 1b. 枚举目录（TFolder，不含根）：过同一套 normalize/过滤（目录按结构处理，不受类型开关影响）
		const dirs: string[] = [];
		const dirSet = new Set<string>();
		for (const f of ctx.vault.getAllLoadedFiles()) {
			if (!(f instanceof TFolder) || f.path === "/") continue;
			const path = normalize(f.path);
			if (ctx.filter.isExcluded(path, true)) continue;
			dirs.push(path);
			dirSet.add(path);
		}
		// 1c. 配置文件（配置目录不在 vault 索引里，走 adapter 枚举与 stat）。
		// 超限的配置文件跳过并只记日志：它是可选能力的附属物，不该把状态卡片钉在「同步受阻」
		const configStat = new Map<string, { mtime: number; size: number }>();
		const skippedConfig: string[] = [];
		for (const path of await ctx.filter.scanConfigFiles(ctx.vault.adapter)) {
			await yieldCtl.tick(100, 50);
			let stat: { mtime: number; size: number } | null = null;
			try {
				stat = await ctx.vault.adapter.stat(path);
			} catch {
				stat = null;
			}
			if (!stat) continue; // 枚举后被删：下一轮自然收敛
			if (isTooBig(stat.size, ctx.maxFileSizeBytes)) {
				skippedConfig.push(path);
				continue;
			}
			configStat.set(path, stat);
		}
		if (skippedConfig.length > 0) {
			debugLog.warn(`[pickpen] ${skippedConfig.length} 个配置文件超过单文件上限，本次跳过`);
		}
		// 大小写冲突检测（大小写不敏感平台；索引文件、目录与配置文件一并纳入）
		const caseConflicts = new Set(
			detectCaseConflicts([...disk.keys(), ...configStat.keys(), ...dirs], ctx.caseInsensitive),
		);

		const tracker = new ProgressTracker(
			disk.size + configStat.size + dirs.length + oversized.length,
			ctx.onProgress,
		);
		for (const path of oversized) tracker.start(path)();

		// 2. 快路径：mtime+size 与 Base 一致 → 复用 entry（不读内容）。
		// needHash 统一承载索引文件与配置文件：两者读盘都走 adapter.readBinary
		const entries: Record<string, Entry> = {};
		const needHash: { path: string }[] = [];
		const base = ctx.base;
		for (const [path, f] of disk) {
			await yieldCtl.tick(100, 50);
			if (caseConflicts.has(path)) {
				tracker.start(path)();
				continue;
			}
			const be = base?.entries[path];
			const stat = f.stat;
			if (
				!ctx.rehashAll &&
				be &&
				be.state === "active" &&
				stat &&
				be.local_mtime === String(stat.mtime) &&
				be.local_size === String(stat.size)
			) {
				const { local_mtime, local_size, ...rest } = be;
				entries[path] = rest;
				tracker.start(path)();
				continue;
			}
			needHash.push(f);
		}
		for (const [path, stat] of configStat) {
			await yieldCtl.tick(100, 50);
			if (caseConflicts.has(path)) {
				tracker.start(path)();
				continue;
			}
			const be = base?.entries[path];
			if (
				!ctx.rehashAll &&
				be &&
				be.state === "active" &&
				be.local_mtime === String(stat.mtime) &&
				be.local_size === String(stat.size)
			) {
				const { local_mtime, local_size, ...rest } = be;
				entries[path] = rest;
				tracker.start(path)();
				continue;
			}
			needHash.push({ path });
		}

		// 3. 内容 hash（新文件/元数据变化才读内容）
		const hashed = await mapConcurrent(needHash, hashConcurrency, async (f) => {
			await yieldCtl.tick(100, 50);
			const finish = tracker.start(f.path);
			try {
				const content = await ctx.vault.adapter.readBinary(f.path);
				// 寻址哈希：加密仓库为密文哈希，未加密仓库为明文 SHA-256；size 恒为明文大小
				const hash = await remoteHash(content);
				return { path: f.path, hash, size: content.byteLength };
			} catch {
				return null; // 读取失败 → blocked
			} finally {
				finish();
			}
		});
		const readFailures = new Set<string>();
		for (const h of hashed) {
			if (!h) continue;
			if (caseConflicts.has(h.path)) continue;
			const np = nfcPath(h.path);
			entries[np ?? h.path] = {
				state: "active",
				content_hash: h.hash,
				size: String(h.size),
				file_id: this.fileIDFor(np ?? h.path, ctx),
			};
		}
		for (let i = 0; i < needHash.length; i++) {
			if (!hashed[i]) readFailures.add(needHash[i].path);
		}

		// 3b. 目录条目物化（统一规则）：磁盘存在的目录（未被排除）→ active dir。
		// 目录与文件同构，rename/删除以 dir 行 tombstone 传播（spec §7.1 dir+children 合法）；
		// 不物化则旧目录无行可 tombstone，重命名后空壳会被当新空目录同步回来
		for (const dir of dirs) {
			const finishProgress = tracker.start(dir);
			let processed = true;
			try {
				await yieldCtl.tick(100, 50);
				if (caseConflicts.has(dir)) continue;
				const np = nfcPath(dir) ?? dir;
				entries[np] = { state: "active", kind: KIND_DIR, file_id: this.fileIDFor(np, ctx) };

			} catch (err) {
				processed = false;
				throw err;
			} finally {
				finishProgress(processed);
			}
		}

		// 4. §7.5 删除状态构造：Base 有而磁盘缺失 → deleted；Base deleted 磁盘缺失 → 保持。
		// 被排除路径必须先跳过：枚举本身是过滤后的，「Base 有、枚举里没有」并不等于磁盘上没有，
		// 合成 deleted 会被 planner 当成「本地删除」提交远端删除（并让整轮在写盘校验处静默放弃）
		if (base) {
			for (const [path, e] of Object.entries(base.entries)) {
				if (ctx.filter.isExcluded(path, (e.kind ?? KIND_FILE) === KIND_DIR)) continue;
				if (disk.has(path) || entries[path] || dirSet.has(path)) continue; // 磁盘存在（或已 active）
				if (e.state === "active" && (oversized.includes(path) || readFailures.has(path))) {
					// 超限/读失败不得推断为删除（§9.2 规则 5）：保留未知，planner 保留远端状态
					continue;
				}
				entries[path] = { state: "deleted", kind: e.kind };
			}
		}

		// 5. blocked = 超限 + 读取失败 + 大小写冲突
		const blockedPaths = [
			...oversized,
			...readFailures,
			...caseConflicts,
		];
		this.current = this.mount(entries);
		return blockedPaths;
	}

	/** dirty 增量：只刷新 dirty 路径（spec §9.2：普通编辑不扫全库；dirty 可为文件夹） */
	private async applyDirty(ctx: LocalScanContext, yieldCtl: YieldControl): Promise<string[]> {
		// 预过滤只用「与 kind 无关」的排除项（目录视角）：类型白名单要等拿到路径的真实类型
		// 之后再判，否则无扩展名的目录会被当成「其他类型文件」误伤
		const dirty = [...(ctx.dirtyPaths ?? [])].filter(
			(path) => !ctx.filter.isExcluded(normalize(path), true) && nfcPath(normalize(path)) !== null,
		);
		const tracker = new ProgressTracker(dirty.length, ctx.onProgress);
		const entries: Record<string, Entry> = { ...this.current!.entries };
		const blockedPaths: string[] = [];
		const dirDirty: string[] = [];

		for (const rawPath of dirty) {
			const finishProgress = tracker.start(rawPath);
			let processed = true;
			try {
				await yieldCtl.tick(100, 50);
				const path = normalize(rawPath);
				const np = nfcPath(path);
				if (np === null) continue;
				// 配置文件不在 vault 索引里（getAbstractFileByPath 恒为 null）：只能按 adapter 判定，
				// 否则会把「索引里没有」误判成真实删除
				if (ctx.filter.isConfigPath(np)) {
					await this.refreshConfigPath(ctx, np, entries);
					continue;
				}
				const abstract = ctx.vault.getAbstractFileByPath(np);
				// 目录判定要兼顾「索引里已经没有了」的删除事件：此时只能从既有条目取 kind
				const prev = entries[np] ?? ctx.base?.entries[np];
				const isDir = abstract instanceof TFolder || (prev?.kind ?? KIND_FILE) === KIND_DIR;
				if (ctx.filter.isExcluded(np, isDir)) continue;
				if (abstract instanceof TFolder) {
					// 文件夹 dirty 先收集：物化判定须在文件处理完后（与 fullAudit 规则 (a) 对齐）
					dirDirty.push(np);
					continue;
				}
				const file = ctx.vault.getFileByPath(np);
				if (!file) {
					// Obsidian 索引已无此文件 = 真实删除（dirty 来自 vault 事件，索引即真相源）：
					// Base/current 有该路径 → deleted；否则忽略（未同步过的路径无状态变化）。
					// 不做磁盘 stat 探测：delete 后文件已移入系统回收站，stat 失败会误判 blocked
					// 导致删除不传播（§9.2 的读失败保护仅适用于索引中存在但读不出的情况，见下方 catch）
					if (prev) {
						entries[np] = { state: "deleted", kind: prev.kind };
					}
					continue;
				}
				const stat = file.stat;
				if (stat && isTooBig(stat.size, ctx.maxFileSizeBytes)) {
					blockedPaths.push(np);
					continue;
				}
				try {
					const content = await ctx.vault.adapter.readBinary(np);
					entries[np] = {
						state: "active",
						content_hash: await remoteHash(content),
						size: String(content.byteLength),
						file_id: this.fileIDFor(np, ctx),
					};
				} catch {
					blockedPaths.push(np);
				}

			} catch (err) {
				processed = false;
				throw err;
			} finally {
				finishProgress(processed);
			}
		}

		// 文件夹物化（统一规则，与 fullAudit 3b 一致）：dirty 目录在索引中存在 → active dir
		for (const np of dirDirty) {
			entries[np] = { state: "active", kind: KIND_DIR, file_id: this.fileIDFor(np, ctx) };
		}

		this.current = this.mount(entries);
		return blockedPaths;
	}

	/**
	 * 刷新单个配置文件（dirty 增量与配置 sweep 共用）：配置目录不在 vault 索引里，
	 * 存在性与内容只能走 adapter。超限 → 跳过（不 blocked）；读失败 → 保留原状态，下一轮重试。
	 */
	private async refreshConfigPath(
		ctx: LocalScanContext,
		path: string,
		entries: Record<string, Entry>,
	): Promise<void> {
		let stat: { size: number } | null = null;
		try {
			stat = await ctx.vault.adapter.stat(path);
		} catch {
			stat = null;
		}
		if (!stat) {
			// 磁盘上确实没有：Base/当前有该路径 → 真实删除（配置文件由应用自身写入，不来自 vault 事件）
			const prev = entries[path] ?? ctx.base?.entries[path];
			if (prev) entries[path] = { state: "deleted", kind: prev.kind };
			return;
		}
		if (isTooBig(stat.size, ctx.maxFileSizeBytes)) {
			debugLog.warn(`[pickpen] 配置文件超过单文件上限，跳过：${path}`);
			return;
		}
		try {
			const content = await ctx.vault.adapter.readBinary(path);
			entries[path] = {
				state: "active",
				content_hash: await remoteHash(content),
				size: String(content.byteLength),
				file_id: this.fileIDFor(path, ctx),
			};
		} catch (err) {
			debugLog.warn(`[pickpen] 读取配置文件失败，保留原状态：${path}（${String(err)}）`);
		}
	}

	/** file_id 解析：Base 复用 → renameHints（newPath→oldPath）继承 → 新生成 UUID。
	 * 目录重命名的 hint 只映射目录路径，子文件按前缀展开继承（b/x.md 经 hint b→a
	 * 取 a/x.md 的 file_id），保整棵子树身份与历史链；未命中则新 UUID（同步正确性无损） */
	private fileIDFor(path: string, ctx: LocalScanContext): string {
		const base = ctx.base;
		const existing = base?.entries[path]?.file_id;
		if (existing) return existing;
		const oldPath = ctx.renameHints?.get(path);
		const inherited = oldPath ? base?.entries[oldPath]?.file_id : undefined;
		if (inherited) return inherited;
		if (ctx.renameHints) {
			for (const [newDir, oldDir] of ctx.renameHints) {
				if (!path.startsWith(newDir + "/")) continue;
				const id = base?.entries[oldDir + path.slice(newDir.length)]?.file_id;
				if (id) return id;
			}
		}
		return newUUID();
	}

	/** 组装 snapshot 骨架（device/vault/revision 跟随 Base，无 Base 时占位） */
	private mount(entries: Record<string, Entry>): Snapshot {
		const base = this.current ?? null;
		return {
			schema_version: 2,
			device_id: base?.device_id ?? "",
			vault_id: base?.vault_id ?? "",
			base_revision: base?.base_revision ?? "0",
			base_root_hash: base?.base_root_hash ?? "",
			entries,
		};
	}
}

function cloneSnapshot(s: Snapshot): Snapshot {
	return { ...s, entries: { ...s.entries } };
}

function emptyLocal(base: Snapshot | null): Snapshot {
	return {
		schema_version: 2,
		device_id: base?.device_id ?? "",
		vault_id: base?.vault_id ?? "",
		base_revision: base?.base_revision ?? "0",
		base_root_hash: base?.base_root_hash ?? "",
		entries: {},
	};
}

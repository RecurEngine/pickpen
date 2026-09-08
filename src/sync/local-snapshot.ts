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

import { TFolder, type TFile, type Vault } from "obsidian";

import { isExcluded, isTooBig, normalize } from "../excludes";
import { nfcPath, detectCaseConflicts } from "./path";
import { sha256Hex } from "./content-hash";
import { KIND_DIR } from "./types";
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
	extraExcludes: string[];
	/** 大小写不敏感平台（Platform.isDesktopApp 为 false 或运行时探测） */
	caseInsensitive: boolean;
	/** 桌面/移动端并发参数（spec §10.1） */
	isMobile: boolean;
	/** 服务端按当前套餐下发的单文件上限。 */
	maxFileSizeBytes: number;
	yieldControl?: YieldControl;
}

export interface LocalScanResult {
	snapshot: Snapshot;
	blockedPaths: string[];
}

/** 移动端：stat 6 并发、hash 1 并发；桌面端：stat 24、hash 4（spec §10.1） */
const STAT_CONCURRENCY = { desktop: 24, mobile: 6 } as const;
const HASH_CONCURRENCY = { desktop: 4, mobile: 1 } as const;

export class LocalSnapshotBuilder {
	/** 内存当前 Local（dirty 增量在其上打补丁；force_audit 全量重建） */
	private current: Snapshot | null = null;
	private blockedPaths = new Set<string>();

	getCurrent(): Snapshot | null {
		return this.current;
	}

	/** 换绑仓库后清空内存状态 */
	reset(): void {
		this.current = null;
		this.blockedPaths.clear();
	}

	/**
	 * 刷新 Local Snapshot。
	 * force_audit：全量枚举重建；否则仅消费 dirtyPaths（dirty 为空且已有 current 时直接返回）。
	 */
	async refresh(ctx: LocalScanContext): Promise<LocalScanResult> {
		const yieldCtl = ctx.yieldControl ?? createYieldControl();
		if (!this.current) {
			// 冷启动：以 Base（若有）为骨架，等 force_audit 校正
			this.current = ctx.base ? cloneSnapshot(ctx.base) : emptyLocal(ctx.base);
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

	/** 完整审计：枚举全部同步范围文件/目录 + §7.5 删除状态构造（spec §9.2 规则 1-5） */
	private async fullAudit(ctx: LocalScanContext, yieldCtl: YieldControl): Promise<string[]> {
		const files = ctx.vault.getFiles();
		const disk = new Map<string, TFile>();
		const statConcurrency = STAT_CONCURRENCY[ctx.isMobile ? "mobile" : "desktop"];
		const hashConcurrency = HASH_CONCURRENCY[ctx.isMobile ? "mobile" : "desktop"];

		// 1. 过滤排除/超限，收集有效路径（TFile.stat 同步，无 Adapter I/O）
		const oversized: string[] = [];
		for (const f of files) {
			await yieldCtl.tick(100, 50);
			const path = normalize(f.path);
			if (isExcluded(path, ctx.extraExcludes)) continue;
			const stat = f.stat;
			if (stat && isTooBig(stat.size, ctx.maxFileSizeBytes)) {
				oversized.push(path);
				continue;
			}
			disk.set(path, f);
		}
		// 1b. 枚举目录（TFolder，不含根）：过同一套 normalize/isExcluded 过滤
		const dirs: string[] = [];
		for (const f of ctx.vault.getAllLoadedFiles()) {
			if (!(f instanceof TFolder) || f.path === "/") continue;
			const path = normalize(f.path);
			if (isExcluded(path, ctx.extraExcludes)) continue;
			dirs.push(path);
		}
		// 大小写冲突检测（大小写不敏感平台；文件与目录一并纳入）
		const caseConflicts = new Set(
			detectCaseConflicts([...disk.keys(), ...dirs], ctx.caseInsensitive),
		);

		// 2. 快路径：mtime+size 与 Base 一致 → 复用 entry（不读内容）
		const entries: Record<string, Entry> = {};
		const needHash: TFile[] = [];
		const base = ctx.base;
		for (const [path, f] of disk) {
			await yieldCtl.tick(100, 50);
			if (caseConflicts.has(path)) continue;
			const be = base?.entries[path];
			const stat = f.stat;
			if (
				be &&
				be.state === "active" &&
				stat &&
				be.local_mtime === String(stat.mtime) &&
				be.local_size === String(stat.size)
			) {
				const { local_mtime, local_size, ...rest } = be;
				entries[path] = rest;
				continue;
			}
			needHash.push(f);
		}

		// 3. 内容 hash（新文件/元数据变化才读内容）
		const hashed = await mapConcurrent(needHash, hashConcurrency, async (f) => {
			await yieldCtl.tick(100, 50);
			try {
				const content = await ctx.vault.adapter.readBinary(f.path);
				const hash = await sha256Hex(content);
				return { path: f.path, hash, size: content.byteLength };
			} catch {
				return null; // 读取失败 → blocked
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
			await yieldCtl.tick(100, 50);
			if (caseConflicts.has(dir)) continue;
			const np = nfcPath(dir) ?? dir;
			entries[np] = { state: "active", kind: KIND_DIR, file_id: this.fileIDFor(np, ctx) };
		}

		// 4. §7.5 删除状态构造：Base 有而磁盘缺失 → deleted；Base deleted 磁盘缺失 → 保持
		if (base) {
			for (const [path, e] of Object.entries(base.entries)) {
				if (disk.has(path) || entries[path] || dirs.includes(path)) continue; // 磁盘存在（或已 active）
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
		const dirty = [...(ctx.dirtyPaths ?? [])];
		const entries: Record<string, Entry> = { ...this.current!.entries };
		const blockedPaths: string[] = [];
		const dirDirty: string[] = [];

		for (const rawPath of dirty) {
			await yieldCtl.tick(100, 50);
			const path = normalize(rawPath);
			if (isExcluded(path, ctx.extraExcludes)) continue;
			const np = nfcPath(path);
			if (np === null) continue;
			const abstract = ctx.vault.getAbstractFileByPath(np);
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
				const prev = entries[np];
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
					content_hash: await sha256Hex(content),
					size: String(content.byteLength),
					file_id: this.fileIDFor(np, ctx),
				};
			} catch {
				blockedPaths.push(np);
			}
		}

		// 文件夹物化（统一规则，与 fullAudit 3b 一致）：dirty 目录在索引中存在 → active dir
		for (const np of dirDirty) {
			entries[np] = { state: "active", kind: KIND_DIR, file_id: this.fileIDFor(np, ctx) };
		}

		this.current = this.mount(entries);
		return blockedPaths;
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

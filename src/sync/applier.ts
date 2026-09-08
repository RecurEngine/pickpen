// 本地应用（spec §9.1 步骤 8/12/13）：临时下载、逐文件安全写入、trash、冲突副本。
// - 「逐文件安全写入」：写插件私有临时文件 → 校验 hash → 替换目标；不承诺跨文件原子
// - 覆盖前比对 Session 开始记录的目标 hash：期间被用户再次修改的文件不覆盖/不删除，
//   重新标记 dirty 由下一轮 planner 处理（spec §9.1 步骤 12）
// - 批量应用分批（25 文件或 50ms）checkpoint pending 并让出事件循环（§10.1）

import { App, normalizePath, TAbstractFile } from "obsidian";

import { sha256Hex } from "./content-hash";
import type { SnapshotRemote } from "./remote";
import type { ApplyAction, ConflictCopy, DownloadItem } from "./types";
import { createYieldControl, mapConcurrent, type YieldControl } from "./utils";
import { copyLocalFile, ensureParentDirs, writeLocalFile } from "./vault-io";

export interface ApplyContext {
	/** Session 开始时记录的目标路径 hash（write 目标内容 / trash 时当前文件 hash） */
	expectedHashes: Map<string, string>;
	/** 提交成功后下载的 expected Head（GetBlob 校验用） */
	expectedRevision: bigint;
	expectedRootHash: string;
	isMobile: boolean;
	yieldControl?: YieldControl;
	/** 被跳过（用户改动）的路径回调：重新标记 dirty */
	onSkipped?: (path: string) => void;
}

const DOWNLOAD_CONCURRENCY = { desktop: 4, mobile: 2 } as const;
const APPLY_BATCH = 25;

export class Applier {
	constructor(
		private readonly app: App,
		private readonly remote: SnapshotRemote,
	) {}

	/**
	 * 下载需要的 Remote Blob 到内存（最大值由当前套餐决定）。返回 hash → 内容。
	 * 移动端串行（DOWNLOAD_CONCURRENCY.mobile=2 且内容即刻写入临时区后释放）。
	 */
	async fetchBlobs(
		downloads: DownloadItem[],
		expectedRevision: bigint,
		expectedRootHash: string,
		isMobile: boolean,
		yieldCtl?: YieldControl,
	): Promise<Map<string, Uint8Array>> {
		const out = new Map<string, Uint8Array>();
		const yc = yieldCtl ?? createYieldControl();
		const concurrency = DOWNLOAD_CONCURRENCY[isMobile ? "mobile" : "desktop"];
		// 去重 hash（同一内容多路径只下载一次）
		const byHash = new Map<string, DownloadItem>();
		for (const d of downloads) byHash.set(d.content_hash, d);
		await mapConcurrent([...byHash.values()], concurrency, async (d) => {
			await yc.tick(100, 50);
			const content = await this.remote.getBlob(d.content_hash, expectedRevision, expectedRootHash);
			// 校验下载内容 hash（传输完整性）；content 可能是 protobuf subarray 视图，直接传视图本身
			const actual = await sha256Hex(content);
			if (actual !== d.content_hash) {
				throw new Error(`下载内容校验失败：${d.path}`);
			}
			out.set(d.content_hash, content);
		});
		return out;
	}

	/** 写插件私有临时文件（跨文件崩溃由 pending 恢复：temp 缺失 → 重新 GetBlob，§9.4） */
	async writeTemp(app: App, tmpPath: string, content: Uint8Array): Promise<void> {
		await writeLocalFile(app, tmpPath, content);
	}

	/**
	 * 应用本地动作（幂等可重复，spec §9.4）：
	 * - write：temp 存在且 hash 匹配 → 写目标；temp 缺失 → GetBlob 重新下载；
	 *   目标已存在且 hash == 目标 hash → 幂等跳过
	 * - trash：文件不存在 → 幂等成功；存在但已被用户改动 → 跳过并标脏
	 * - 冲突副本：源文件 hash 匹配 → 本地复制；否则 GetBlob 下载
	 * 返回被跳过（重新标脏）的路径。
	 */
	async applyPlan(args: {
		actions: ApplyAction[];
		conflicts: ConflictCopy[];
		expectedHashes: Map<string, string>;
		expectedRevision: bigint;
		expectedRootHash: string;
		tmpDir: string;
		isMobile: boolean;
		yieldControl?: YieldControl;
		onSkipped?: (path: string) => void;
	}): Promise<string[]> {
		const { actions, conflicts, expectedHashes, expectedRevision, expectedRootHash, tmpDir } = args;
		const yc = args.yieldControl ?? createYieldControl();
		const skipped = new Set<string>();
		let batchCount = 0;

		const maybeYield = async (): Promise<void> => {
			batchCount++;
			if (batchCount >= APPLY_BATCH) {
				batchCount = 0;
				await yc.tick(1, 50);
			} else {
				await yc.tick(100, 50);
			}
		};

		for (const action of actions) {
			await maybeYield();
			if (action.kind === "mkdir") {
				// 幂等创建目录（先逐级建父目录）
				await ensureParentDirs(this.app, action.path);
				if (!(await this.app.vault.adapter.exists(action.path))) {
					await this.app.vault.adapter.mkdir(action.path);
				}
				continue;
			}
			if (action.kind === "rmdir") {
				// 删除空目录；非空/失败 → 跳过（下一轮对账重试）。
				// Obsidian 1.13 的 adapter.rmdir(path, false) 对空目录也报 EISDIR（内部走 rm），
				// 须先确认目录为空再用 recursive 删除；非空说明期间有新内容，跳过
				if (!(await this.app.vault.adapter.exists(action.path))) continue; // 幂等成功
				try {
					const listing = await this.app.vault.adapter.list(action.path);
					if (listing.files.length === 0 && listing.folders.length === 0) {
						await this.app.vault.adapter.rmdir(action.path, true);
					} else {
						skipped.add(action.path);
					}
				} catch {
					skipped.add(action.path);
				}
				continue;
			}
			if (action.kind === "trash") {
				const file = this.app.vault.getFileByPath(action.path);
				if (!file) continue; // 幂等成功
				// 用户在此期间改动过文件（hash 与 Session 开始时记录不符）→ 不删
				if (expectedHashes.has(action.path)) {
					try {
						const content = await this.app.vault.adapter.readBinary(action.path);
						const hash = await sha256Hex(content);
						if (hash !== expectedHashes.get(action.path)) {
							skipped.add(action.path);
							continue;
						}
					} catch {
						continue; // 读失败视为不存在，幂等跳过
					}
				}
				await this.app.vault.trash(file, false);
				continue;
			}

			// write
			const content = await this.loadWriteContent(action, expectedRevision, expectedRootHash, tmpDir);
			if (!content) {
				skipped.add(action.path);
				continue;
			}
			// 目标已存在且已是目标内容 → 幂等跳过
			const existing = this.app.vault.getFileByPath(action.path);
			if (existing) {
				const disk = await this.app.vault.adapter.readBinary(action.path);
				const diskHash = await sha256Hex(disk);
				if (diskHash === action.content_hash) continue;
				// 目标存在但内容不同：Session 开始后用户改过 → 不覆盖，重新标脏
				if (expectedHashes.has(action.path) && diskHash !== expectedHashes.get(action.path)) {
					skipped.add(action.path);
					continue;
				}
			}
			await writeLocalFile(this.app, action.path, content);
		}

		// 冲突副本：优先从本地源复制（内容即源文件 hash），源失效则 GetBlob
		for (const cc of conflicts) {
			await maybeYield();
			const target = this.app.vault.getFileByPath(cc.path);
			if (target) {
				const disk = await this.app.vault.adapter.readBinary(cc.path);
				if ((await sha256Hex(disk)) === cc.content_hash) continue; // 幂等
			}
			let content: Uint8Array | null = null;
			try {
				const src = await this.app.vault.adapter.readBinary(cc.source_path);
				if ((await sha256Hex(src)) === cc.content_hash) {
					content = new Uint8Array(src);
				}
			} catch {
				// 源已消失 → 走 GetBlob
			}
			if (!content) {
				content = await this.remote.getBlob(cc.content_hash, expectedRevision, expectedRootHash);
			}
			await writeLocalFile(this.app, cc.path, content);
		}

		if (args.onSkipped) {
			for (const p of skipped) args.onSkipped(p);
		}
		return [...skipped];
	}

	/** write 动作取内容：temp 文件（hash 校验）→ 失败则 GetBlob 重新下载（§9.4） */
	private async loadWriteContent(
		action: ApplyAction,
		expectedRevision: bigint,
		expectedRootHash: string,
		tmpDir: string,
	): Promise<Uint8Array | null> {
		if (action.temp_path) {
			try {
				const raw = await this.app.vault.adapter.readBinary(normalizePath(action.temp_path));
				if ((await sha256Hex(raw)) === action.content_hash) {
					return new Uint8Array(raw);
				}
			} catch {
				// temp 缺失/损坏 → 重新下载
			}
		}
		try {
			const content = await this.remote.getBlob(action.content_hash, expectedRevision, expectedRootHash);
			if ((await sha256Hex(content)) === action.content_hash) {
				return content;
			}
		} catch {
			// 下载失败：跳过（下一轮重试）
		}
		return null;
	}

	/** 清理临时区（spec §9.1 步骤 14） */
	async cleanupTemp(tmpDir: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(tmpDir))) return;
		try {
			const files = await adapter.list(tmpDir);
			for (const f of files.files) {
				try {
					await adapter.remove(f);
				} catch {
					// 尽力而为
				}
			}
			for (const d of files.folders) {
				try {
					await adapter.rmdir(d, true);
				} catch {
					// 尽力而为
				}
			}
		} catch {
			// 尽力而为
		}
	}
}

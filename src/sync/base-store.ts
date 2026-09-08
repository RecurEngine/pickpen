// Base Snapshot Store（spec §6.4）：sync-base.json，schema_version 2。
// - 位置不变：插件自身目录（.obsidian/plugins/<id>/），经 vault.adapter 读写
// - device_id/schema_version/vault_id 三重校验；不匹配或损坏 → 安全 Bootstrap，
//   绝不把空 Base 当成「远端全部删除」（spec §6.4）
// - 写 Base 前对每个 active 条目重新 stat 记录实际落盘 mtime/size（远端下载文件
//   写盘后的 mtime 是下载时间，不能沿用旧值，否则下一轮快路径误判脏）
// - 原子写：临时文件 + rename，防半写损坏

import { App, normalizePath, Plugin } from "obsidian";

import { debugLog } from "../debug-log";
import type { Entry, Snapshot } from "./types";

export type BaseLoadResult = "ok" | "no-base" | "corrupt";

export class BaseStore {
	private readonly app: App;
	private readonly deviceId: string;
	private readonly baseFilePath: string;
	private base: Snapshot | null = null;
	private dirty = false;

	constructor(plugin: Plugin, deviceId: string) {
		this.app = plugin.app;
		this.deviceId = deviceId;
		this.baseFilePath = normalizePath(`${plugin.manifest.dir}/sync-base.json`);
	}

	getBase(): Snapshot | null {
		return this.base;
	}

	/** 换绑仓库时调用：旧 Base 对新仓库无效（且会触发「远端已删 → trash」批量删本地） */
	reset(): void {
		this.base = null;
		this.dirty = true;
	}

	/** 启动时加载；损坏/device 不匹配返回 corrupt（触发安全 Bootstrap 与 force_audit） */
	async load(): Promise<BaseLoadResult> {
		this.base = null;
		let raw: string;
		try {
			raw = await this.app.vault.adapter.read(this.baseFilePath);
		} catch {
			return "no-base"; // 文件不存在：首次绑定
		}
		let parsed: Snapshot;
		try {
			parsed = JSON.parse(raw) as Snapshot;
		} catch {
			return "corrupt";
		}
		if (
			parsed.schema_version !== 2 ||
			parsed.device_id !== this.deviceId ||
			typeof parsed.vault_id !== "string" ||
			typeof parsed.base_revision !== "string" ||
			typeof parsed.base_root_hash !== "string" ||
			!parsed.entries
		) {
			debugLog.warn("[pickpen] sync-base.json 结构异常或 device 不匹配，进入安全 Bootstrap");
			return "corrupt";
		}
		this.base = parsed;
		debugLog.info(`[pickpen] Base Snapshot 已加载（${Object.keys(parsed.entries).length} 条）`);
		return "ok";
	}

	/**
	 * 写新 Base。写盘前对每个 active 条目重新 stat，记录实际落盘 mtime/size；
	 * 磁盘上已不存在的 active 条目删除其 local_* 快路径字段（下一轮按 dirty 处理）。
	 */
	async saveBase(snapshot: Snapshot): Promise<void> {
		const entries: Record<string, Entry> = {};
		for (const [path, e] of Object.entries(snapshot.entries)) {
			if (e.state !== "active") {
				entries[path] = { ...e };
				continue;
			}
			let stat: { mtime: number; size: number } | null = null;
			try {
				stat = await this.app.vault.adapter.stat(path);
			} catch {
				// 视为不存在
			}
			if (stat) {
				entries[path] = {
					...e,
					local_mtime: String(stat.mtime),
					local_size: String(stat.size),
				};
			} else {
				const { local_mtime: _m, local_size: _s, ...rest } = e;
				entries[path] = rest;
			}
		}
		const payload = JSON.stringify({ ...snapshot, entries });
		this.base = { ...snapshot, entries };
		await this.atomicWrite(payload);
		this.dirty = false;
	}

	/** 原子写：临时文件 → rename（目标已存在时先移除，窗口内崩溃最多退化为 no-base，安全） */
	private async atomicWrite(payload: string): Promise<void> {
		const tmpPath = `${this.baseFilePath}.tmp`;
		await this.app.vault.adapter.write(tmpPath, payload);
		try {
			await this.app.vault.adapter.rename(tmpPath, this.baseFilePath);
		} catch {
			try {
				await this.app.vault.adapter.remove(this.baseFilePath);
			} catch {
				// 目标不存在则无需移除
			}
			await this.app.vault.adapter.rename(tmpPath, this.baseFilePath);
		}
	}

	/** 立即落盘（卸载时调用） */
	async flush(): Promise<void> {
		if (!this.dirty || !this.base) return;
		await this.saveBase(this.base);
	}
}

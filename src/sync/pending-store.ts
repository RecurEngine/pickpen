// sync-pending-v2.json 本地提交日志（spec §9.4）：覆盖 Blob 暂存、服务端提交、
// 本地应用和 Base 落盘之间的所有崩溃窗口。动作必须可重复执行，恢复时通过目标
// 路径实际 hash 判断动作是否已完成。原子写：临时文件 + rename。

import { App, normalizePath, Plugin } from "obsidian";

import { debugLog } from "../debug-log";
import type { PendingLog } from "./types";

export class PendingStore {
	private readonly app: App;
	private readonly pendingFilePath: string;
	private pending: PendingLog | null = null;

	constructor(plugin: Plugin) {
		this.app = plugin.app;
		this.pendingFilePath = normalizePath(`${plugin.manifest.dir}/sync-pending-v2.json`);
	}

	getPending(): PendingLog | null {
		return this.pending;
	}

	/** 启动时加载（损坏 → 丢弃并返回 null，由完整审计兜底） */
	async load(): Promise<PendingLog | null> {
		this.pending = null;
		let raw: string;
		try {
			raw = await this.app.vault.adapter.read(this.pendingFilePath);
		} catch {
			return null;
		}
		try {
			const parsed = JSON.parse(raw) as PendingLog;
			if (parsed.schema_version === 2 && parsed.apply_actions) {
				this.pending = parsed;
				return parsed;
			}
		} catch {
			// 损坏：丢弃
		}
		debugLog.warn("[pickpen] sync-pending-v2.json 损坏，丢弃（由完整审计兜底）");
		return null;
	}

	/** CommitSnapshot 请求前落盘（phase=prepared，覆盖「Commit 成功、响应丢失」窗口） */
	async writePrepared(log: Omit<PendingLog, "phase" | "target_revision">): Promise<void> {
		const full: PendingLog = {
			...log,
			phase: "prepared",
			target_revision: null,
		};
		this.pending = full;
		await this.atomicWrite(JSON.stringify(full));
	}

	/** Commit 成功后原子更新 phase/target_revision */
	async markCommitted(targetRevision: string): Promise<void> {
		if (!this.pending) return;
		this.pending = { ...this.pending, phase: "committed", target_revision: targetRevision };
		await this.atomicWrite(JSON.stringify(this.pending));
	}

	/** 开始本地应用 */
	async markApplying(): Promise<void> {
		if (!this.pending) return;
		this.pending = { ...this.pending, phase: "applying" };
		await this.atomicWrite(JSON.stringify(this.pending));
	}

	/** 完成收敛后删除 pending 文件 */
	async clear(): Promise<void> {
		this.pending = null;
		try {
			await this.app.vault.adapter.remove(this.pendingFilePath);
		} catch {
			// 文件不存在视为已清除
		}
	}

	private async atomicWrite(payload: string): Promise<void> {
		const tmpPath = `${this.pendingFilePath}.tmp`;
		await this.app.vault.adapter.write(tmpPath, payload);
		try {
			await this.app.vault.adapter.rename(tmpPath, this.pendingFilePath);
		} catch {
			try {
				await this.app.vault.adapter.remove(this.pendingFilePath);
			} catch {
				// 目标不存在则无需移除
			}
			await this.app.vault.adapter.rename(tmpPath, this.pendingFilePath);
		}
	}
}

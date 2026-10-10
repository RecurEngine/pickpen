// 大文件传输痕迹：进程被杀（OOM/闪退）时内存日志一并消失，崩溃现场只剩这个文件。
// 传输开始前落盘一条记录、结束后删除；下次启动读到残留即说明上次在此中断。
// 尽力而为：写失败只记日志，绝不影响同步本身；记录只含 vault 相对路径与字节数。
//
// 只对达到阈值的传输落盘：小文件传输频繁，写盘抖动不划算，也不是崩溃场景。

import type { App } from "obsidian";

import { debugLog } from "../debug-log";

/** 触发记录的最小体积（明文/密文字节数），与「大文件」口径一致 */
export const TRANSFER_MARK_MIN_BYTES = 8 * 1024 * 1024;

export interface TransferMark {
	schema: 1;
	kind: "upload" | "download";
	/** vault 相对路径（仅用于向用户指出中断位置） */
	path: string;
	bytes: number;
	started_at: string;
}

export function transferJournalPath(pluginDir: string): string {
	return `${pluginDir}/sync-transfer.json`;
}

/** 字节数 → 提示文案里的体积（MB，一位小数） */
export function formatTransferSize(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 记录「开始传输一个可能耗时/耗内存的对象」 */
export async function beginTransfer(
	app: App,
	pluginDir: string,
	mark: Omit<TransferMark, "schema" | "started_at">,
): Promise<void> {
	if (mark.bytes < TRANSFER_MARK_MIN_BYTES) return;
	try {
		const record: TransferMark = { schema: 1, started_at: new Date().toISOString(), ...mark };
		await app.vault.adapter.write(transferJournalPath(pluginDir), JSON.stringify(record));
	} catch (err) {
		debugLog.warn(`[pickpen] 写入传输痕迹失败：${String(err)}`);
	}
}

/** 传输结束：删除痕迹（尽力而为） */
export async function endTransfer(app: App, pluginDir: string): Promise<void> {
	try {
		await app.vault.adapter.remove(transferJournalPath(pluginDir));
	} catch {
		// 文件不存在即正常
	}
}

/** 读取上次中断的传输记录（读到即消费删除，只提示一次） */
export async function readInterrupted(
	app: App,
	pluginDir: string,
): Promise<TransferMark | null> {
	const path = transferJournalPath(pluginDir);
	let mark: TransferMark | null = null;
	try {
		if (!(await app.vault.adapter.exists(path))) return null;
		const raw = await app.vault.adapter.read(path);
		const parsed = JSON.parse(raw) as TransferMark;
		if (parsed && parsed.schema === 1 && typeof parsed.path === "string") mark = parsed;
	} catch {
		mark = null; // 损坏的记录直接丢弃
	}
	await endTransfer(app, pluginDir);
	return mark;
}

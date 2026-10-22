// 手动同步（Ribbon / 「立即同步」命令）结束后的结果回执：把同步运行态翻译成一句给用户看的文案。
// 措辞与设置页状态卡片（settings.ts 的 deriveStatus）保持一致，便于用户两边对照。

import { blockedReasonLabel } from "./blocked-status";
import type { BlockedPathInfo } from "./sync/blocked";

export interface SyncResultInput {
	pausedReason: string;
	lastError: string;
	storageLimitExceeded: boolean;
	blockedCount: number;
	/** 未同步路径与原因（可选）：单个文件时回执里点名文件，说明为什么没传上去 */
	blockedPaths?: readonly string[];
	blockedDetails?: readonly BlockedPathInfo[];
	maxFileSizeBytes?: number;
	/** 待处理的冲突副本数（存量）。同步本身已完成，只是有副本等用户核对 */
	conflictCount: number;
	changed: boolean; // 本轮是否真的同步到了内容（远端落地或本地提交）
}

/** 未同步文件的回执片段：单个文件点名并给出原因，多个只报数量 */
function blockedNote(input: SyncResultInput): string {
	const count = Math.max(input.blockedCount, input.blockedPaths?.length ?? 0);
	if (count === 0) return "";
	if (count === 1) {
		const path = input.blockedPaths?.[0];
		if (!path) return "1 个文件暂未同步";
		const reason = input.blockedDetails?.find((detail) => detail.path === path)?.reason;
		const label = reason ? blockedReasonLabel(reason, input.maxFileSizeBytes ?? 0) : "";
		return label ? `1 个文件暂未同步（${path}：${label}）` : `1 个文件暂未同步（${path}）`;
	}
	return `${count} 个文件暂未同步`;
}

/** 会话里的失败原因有的自带「同步失败：」前缀（通用失败），有的不带（令牌失效、容量超限），统一只留一份前缀。 */
function failureReason(lastError: string): string {
	return lastError.replace(/^同步失败：/, "");
}

export function syncResultMessage(input: SyncResultInput): string {
	if (input.pausedReason) return `同步已暂停：${input.pausedReason}`;
	if (input.storageLimitExceeded) return "同步已暂停：云端存储已满";
	if (input.lastError) return `同步失败：${failureReason(input.lastError)}`;
	// 未同步是「个别文件本轮没传上去」，冲突副本是「同步完了但有事要处理」：两类都报，不互相顶掉
	const notes: string[] = [];
	const blocked = blockedNote(input);
	if (blocked) notes.push(blocked);
	if (input.conflictCount > 0) notes.push(`${input.conflictCount} 个冲突副本待处理`);
	if (notes.length > 0) return `同步完成，但有 ${notes.join("、")}`;
	if (input.changed) return "同步完成";
	return "已全部同步（无变化）";
}

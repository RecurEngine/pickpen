// 手动同步（Ribbon / 「立即同步」命令）结束后的结果回执：把同步运行态翻译成一句给用户看的文案。
// 措辞与设置页状态卡片（settings.ts 的 deriveStatus）保持一致，便于用户两边对照。

export interface SyncResultInput {
	pausedReason: string;
	lastError: string;
	storageLimitExceeded: boolean;
	blockedCount: number;
	/** 待处理的冲突副本数（存量）。同步本身已完成，只是有副本等用户核对 */
	conflictCount: number;
	changed: boolean; // 本轮是否真的同步到了内容（远端落地或本地提交）
}

/** 会话里的失败原因有的自带「同步失败：」前缀（通用失败），有的不带（令牌失效、容量超限），统一只留一份前缀。 */
function failureReason(lastError: string): string {
	return lastError.replace(/^同步失败：/, "");
}

export function syncResultMessage(input: SyncResultInput): string {
	if (input.pausedReason) return `同步已暂停：${input.pausedReason}`;
	if (input.storageLimitExceeded) return "同步已暂停：云端存储已满";
	if (input.lastError) return `同步失败：${failureReason(input.lastError)}`;
	// 被阻塞是「本轮没同步完」，冲突副本是「同步完了但有事要处理」：两类都报，不互相顶掉
	const notes: string[] = [];
	if (input.blockedCount > 0) notes.push(`${input.blockedCount} 个文件被阻塞`);
	if (input.conflictCount > 0) notes.push(`${input.conflictCount} 个冲突副本待处理`);
	if (notes.length > 0) return `同步完成，但有 ${notes.join("、")}`;
	if (input.changed) return "同步完成";
	return "已全部同步（无变化）";
}

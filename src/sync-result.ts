// 手动同步（Ribbon / 「立即同步」命令）结束后的结果回执：把同步运行态翻译成一句给用户看的文案。
// 措辞与设置页状态卡片（settings.ts 的 deriveStatus）保持一致，便于用户两边对照。

export interface SyncResultInput {
	pausedReason: string;
	lastError: string;
	storageLimitExceeded: boolean;
	blockedCount: number;
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
	if (input.blockedCount > 0) return `同步完成，但有 ${input.blockedCount} 个文件被阻塞`;
	if (input.changed) return "同步完成";
	return "已全部同步（无变化）";
}

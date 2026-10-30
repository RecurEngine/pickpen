// 未同步（被阻塞）路径的原因明细：扫描层产出，会话合并云端存量超限后供 UI 展示。
// 这些路径本轮不参与上传/删除，但其他路径照常同步，不影响整体同步结果。

export type BlockedReason =
	| "oversized" // 本地文件超过当前套餐的单文件上限
	| "read_failed" // 本地内容读取失败（下一轮会重试）
	| "case_conflict" // 与另一路径仅大小写不同，大小写不敏感平台上无法共存
	| "path_unencodable" // 路径加密仓库：NFC/长度/目录层数超出 token 编码能力
	| "remote_oversized"; // 云端已有内容超过当前套餐的单文件上限（升级套餐后自动恢复）

export interface BlockedPathInfo {
	path: string;
	reason: BlockedReason;
}

/**
 * 合并本地阻塞明细与云端存量超限路径：同一路径只保留一条，本地原因优先。
 *
 * 只用于展示。planner 仍按各自语义分别处理两类路径（本地阻塞钉住远端状态、
 * 云端超限保持远端原值），不能互换，因此这里的结果不得回灌给对账逻辑。
 */
export function mergeBlockedDetails(
	localDetails: readonly BlockedPathInfo[],
	remoteOversizedPaths: readonly string[],
): BlockedPathInfo[] {
	const merged: BlockedPathInfo[] = [];
	const seen = new Set<string>();
	for (const detail of localDetails) {
		if (seen.has(detail.path)) continue;
		seen.add(detail.path);
		merged.push(detail);
	}
	for (const path of remoteOversizedPaths) {
		if (seen.has(path)) continue;
		seen.add(path);
		merged.push({ path, reason: "remote_oversized" });
	}
	return merged;
}

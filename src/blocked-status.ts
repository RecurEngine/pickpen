// 未同步文件的展示文案（设置页状态卡片、手动同步回执共用）。
// 纯函数、不依赖 DOM：让「哪些文件没同步、为什么」的措辞只有一份实现。

import { formatQuotaBytes } from "./subscription-state-view";
import type { BlockedPathInfo, BlockedReason } from "./sync/blocked";

/** 明细行最多列出的文件名个数，其余折叠为「等 N 个文件」 */
const MAX_LISTED = 3;

/** 原因归类计数的固定顺序（与 BlockedReason 的声明顺序一致） */
const REASON_ORDER: readonly BlockedReason[] = [
	"oversized",
	"read_failed",
	"case_conflict",
	"path_unencodable",
	"remote_oversized",
];

/** 折叠时的归类短语（比单文件短语短，便于一行放下） */
const GROUP_LABELS: Record<BlockedReason, string> = {
	oversized: "超过单文件上限",
	read_failed: "无法读取本地内容",
	case_conflict: "大小写冲突",
	path_unencodable: "路径过深无法加密",
	remote_oversized: "云端存量文件超限",
};

export interface BlockedFile {
	path: string;
	/** null = 只有路径、没有原因明细（旧状态或防御性输入） */
	reason: BlockedReason | null;
	/** 单文件展示用的原因短语；无原因时为空串 */
	reasonLabel: string;
}

export interface BlockedSummary {
	count: number;
	/** 主文案，如「1 个文件暂未同步」；无未同步文件时为空串 */
	headline: string;
	/** 明细文案（可能两行：文件名行 + 「其他文件不受影响」）；无未同步文件时为空串 */
	detail: string;
	files: BlockedFile[];
}

export interface BlockedSummaryInput {
	blockedPaths: readonly string[];
	blockedDetails: readonly BlockedPathInfo[];
	/** 当前套餐的单文件上限（字节）；<=0 表示未知，文案里省略具体数值 */
	maxFileSizeBytes: number;
}

/** 单文件原因短语（设置页明细行、通知回执共用） */
export function blockedReasonLabel(reason: BlockedReason, maxFileSizeBytes: number): string {
	const limit = maxFileSizeBytes > 0 ? ` ${formatQuotaBytes(BigInt(maxFileSizeBytes))}` : "";
	switch (reason) {
		case "oversized":
			return `超过单文件上限${limit}`;
		case "read_failed":
			return "无法读取本地内容，下次同步会重试";
		case "case_conflict":
			return "与另一项名称仅大小写不同";
		case "path_unencodable":
			return "路径过深或名称无法加密，暂不能同步";
		case "remote_oversized":
			return `云端已有内容超过单文件上限${limit}，升级套餐后自动恢复`;
	}
}

/** 按明细去重建序，再补上只出现在 blockedPaths 里的路径，保证任何状态下都能显示文件名 */
function normalizeFiles(input: BlockedSummaryInput): BlockedFile[] {
	const files: BlockedFile[] = [];
	const seen = new Set<string>();
	for (const detail of input.blockedDetails) {
		if (seen.has(detail.path)) continue;
		seen.add(detail.path);
		files.push({
			path: detail.path,
			reason: detail.reason,
			reasonLabel: blockedReasonLabel(detail.reason, input.maxFileSizeBytes),
		});
	}
	for (const path of input.blockedPaths) {
		if (seen.has(path)) continue;
		seen.add(path);
		files.push({ path, reason: null, reasonLabel: "" });
	}
	return files;
}

/** 折叠时的归类计数，如「；其中 3 个超过单文件上限、1 个无法读取本地内容」 */
function groupText(files: readonly BlockedFile[]): string {
	const counts = new Map<BlockedReason, number>();
	for (const file of files) {
		if (file.reason) counts.set(file.reason, (counts.get(file.reason) ?? 0) + 1);
	}
	const parts = REASON_ORDER.filter((reason) => counts.has(reason)).map(
		(reason) => `${counts.get(reason) ?? 0} 个${GROUP_LABELS[reason]}`,
	);
	return parts.length > 0 ? `；其中 ${parts.join("、")}` : "";
}

export function summarizeBlocked(input: BlockedSummaryInput): BlockedSummary {
	const files = normalizeFiles(input);
	const count = files.length;
	if (count === 0) return { count: 0, headline: "", detail: "", files: [] };
	const listed = files
		.slice(0, MAX_LISTED)
		.map((file) => (file.reasonLabel ? `${file.path}（${file.reasonLabel}）` : file.path))
		.join("、");
	const folded = count > MAX_LISTED ? ` 等 ${count} 个文件` : "";
	const groups = count > MAX_LISTED ? groupText(files) : "";
	return {
		count,
		headline: `${count} 个文件暂未同步`,
		detail: `未同步文件：${listed}${folded}${groups}\n其他文件不受影响`,
		files,
	};
}

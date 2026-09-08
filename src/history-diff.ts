// 历史版本 diff（行级 + 行内字符高亮）：diffTexts 纯函数，不依赖 DOM，可单测。
// 语义：历史版本内容（旧）→ 当前文件内容（新）；del = 历史独有（被删/改），add = 当前新增。

import { diffArrays, diffWordsWithSpace } from "diff";

// DiffChange 行内字符段：无标记 = 相同；removed/added = 该行内具体变化段
export interface DiffChange {
	added?: boolean;
	removed?: boolean;
	value: string;
}

// DiffLine 渲染行：same = 未变；add/del 携带配对行的行内高亮段
export interface DiffLine {
	type: "add" | "del" | "same";
	text: string;
	changes?: DiffChange[];
}

// toLines 文本按 \n 切分为行数组：剥 CR（CRLF 文件）；末尾换行不产生空行
function toLines(text: string): string[] {
	const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

// wordChanges 行级配对 → 行内字符段（removed 行取 removed 段、added 行取 added 段，same 段保留顺序）
function wordChanges(oldLine: string, newLine: string, kind: "del" | "add"): DiffChange[] {
	return diffWordsWithSpace(oldLine, newLine)
		.filter((p) => (kind === "del" ? !p.added : !p.removed))
		.map((p) =>
			kind === "del"
				? { value: p.value, removed: p.removed || undefined }
				: { value: p.value, added: p.added || undefined },
		);
}

// diffTexts 历史版本内容 vs 当前文件内容 → 行级 diff（改动行相邻 del/add 成对，行内含高亮段）
// 行数组整体比较（diffArrays）：行是原子 token，无行尾换行跨界问题
export function diffTexts(oldText: string, newText: string): DiffLine[] {
	const blocks = diffArrays(toLines(oldText), toLines(newText));
	const lines: DiffLine[] = [];
	let removed: string[] = [];
	let added: string[] = [];
	// flush 相邻 changed 块按行配对：行数相等逐行 diffWordsWithSpace，不等则跳过行内高亮
	const flush = (): void => {
		const pairs = Math.min(removed.length, added.length);
		for (let i = 0; i < removed.length; i++) {
			lines.push({
				type: "del",
				text: removed[i],
				changes: i < pairs ? wordChanges(removed[i], added[i], "del") : undefined,
			});
		}
		for (let i = 0; i < added.length; i++) {
			lines.push({
				type: "add",
				text: added[i],
				changes: i < pairs ? wordChanges(removed[i], added[i], "add") : undefined,
			});
		}
		removed = [];
		added = [];
	};
	for (const block of blocks) {
		if (block.added) {
			added.push(...block.value);
		} else if (block.removed) {
			removed.push(...block.value);
		} else {
			flush();
			for (const text of block.value) lines.push({ type: "same", text });
		}
	}
	flush();
	return lines;
}

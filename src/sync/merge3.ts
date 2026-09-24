// 三方合并（spec §8.2 扩展）：Base / Local / Remote 行级合并，纯函数、无 I/O。
//
// 语义对齐 GNU diff3 与 git merge-file（两者在下列边界上一致，已用本机 /usr/bin/diff3
// 与 git merge-file 逐例对拍）：
// - 两侧相邻（含相接）的不稳定区合并为同一个冲突区：diff3 要求两处改动之间有未变的行
//   才算互相独立，否则视为一处冲突；
// - 双方改成完全相同的内容不算冲突（git 行为；BSD diff3 在这一点上会报冲突，取 git）；
// - 纯插入按零宽区处理，两端在同一锚点插入不同内容 → 冲突。
//
// 输出只在无冲突时产出；有冲突只报冲突区数量，不生成 <<<<<<< 标记——调用方退回冲突副本
// （保留双份完整文件），不做行内标记。
//
// 行按「含自身行尾换行」切分（splitKeepingEol）：原样拼接即字节级还原，不做 CRLF 归一化，
// 也绝不在合并成功时改动未变行的字节。

import { diffArrays } from "diff";

export interface MergeOutcome {
	/** 无冲突：text 为合并结果 */
	clean: boolean;
	/** 无冲突时的合并文本（字节级，含原行尾） */
	text?: string;
	/** 有冲突时的冲突区数量（仅用于日志；调用方只需 clean） */
	conflictCount: number;
}

/** 行切分：每行保留自己的行尾换行，join("") 即原样还原（末尾无换行也保持原样） */
function splitKeepingEol(text: string): string[] {
	if (text === "") return [];
	return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** side 相对 base 的一处改动：base[baseStart,baseEnd) ←→ side[sideStart,sideEnd)（纯插入/纯删除时有一段为零宽） */
interface Region {
	baseStart: number;
	baseEnd: number;
	sideStart: number;
	sideEnd: number;
}

/**
 * 取 side 相对 base 的改动区列表（按 baseStart 升序、互不重叠）。
 * jsdiff 的改动块恒为 removed 在前、added 在后；纯删除（只 removed）与纯插入
 * （只 added）分别对应零宽的 side 段与 base 段。
 */
function changeRegions(base: string[], side: string[]): Region[] {
	const regions: Region[] = [];
	let basePos = 0;
	let sidePos = 0;
	// 悬空的 removed：等紧随其后的 added 配对；两者都不来则收尾时落成纯删除
	let pendingRemoved: { start: number; end: number } | null = null;
	for (const block of diffArrays(base, side)) {
		const n = block.value.length;
		if (block.removed) {
			pendingRemoved = { start: basePos, end: basePos + n };
			basePos += n;
			continue;
		}
		if (block.added) {
			const start = pendingRemoved ? pendingRemoved.start : basePos;
			regions.push({ baseStart: start, baseEnd: basePos, sideStart: sidePos, sideEnd: sidePos + n });
			pendingRemoved = null;
			sidePos += n;
			continue;
		}
		if (pendingRemoved) {
			regions.push({
				baseStart: pendingRemoved.start,
				baseEnd: pendingRemoved.end,
				sideStart: sidePos,
				sideEnd: sidePos,
			});
			pendingRemoved = null;
		}
		basePos += n;
		sidePos += n;
	}
	if (pendingRemoved) {
		regions.push({
			baseStart: pendingRemoved.start,
			baseEnd: pendingRemoved.end,
			sideStart: sidePos,
			sideEnd: sidePos,
		});
	}
	return regions;
}

/**
 * 某一侧在冲突区 [start,end) 上的文本：
 * 未变间隙直接取 base 行（diff 的未变块保证与该侧严格相等），改动段取该侧自身的行。
 */
function chunkText(base: string[], side: string[], chunk: Region[], start: number, end: number): string[] {
	const out: string[] = [];
	let cursor = start;
	for (const r of chunk) {
		out.push(...base.slice(cursor, r.baseStart));
		out.push(...side.slice(r.sideStart, r.sideEnd));
		cursor = r.baseEnd;
	}
	out.push(...base.slice(cursor, end));
	return out;
}

function linesEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * 三方合并。base 为共同祖先，ours 为本地内容，theirs 为远端内容。
 * 任一侧与 base 逐字节相同 → 直接取另一侧；两侧相同 → 直接取该结果（这三条是常见路径的
 * 快路，也避免了对超大文件做无谓的 diff）。
 */
export function merge3Text(base: string, ours: string, theirs: string): MergeOutcome {
	if (ours === theirs) return { clean: true, text: ours, conflictCount: 0 };
	if (base === ours) return { clean: true, text: theirs, conflictCount: 0 };
	if (base === theirs) return { clean: true, text: ours, conflictCount: 0 };

	const baseLines = splitKeepingEol(base);
	const ourLines = splitKeepingEol(ours);
	const theirLines = splitKeepingEol(theirs);
	const ourRegions = changeRegions(baseLines, ourLines);
	const theirRegions = changeRegions(baseLines, theirLines);

	const out: string[] = [];
	let conflicts = 0;
	let i = 0;
	let j = 0;
	let pos = 0;

	while (i < ourRegions.length || j < theirRegions.length) {
		const o = ourRegions[i];
		const t = theirRegions[j];
		const start = Math.min(o ? o.baseStart : Infinity, t ? t.baseStart : Infinity);
		if (start === Infinity) break;
		// start 之前是两侧都未变的 base 行
		out.push(...baseLines.slice(pos, start));

		// 收集与当前区相接/重叠的全部区域：两侧交替吸收，直到 end 不再增长
		let end = start;
		const ourChunk: Region[] = [];
		const theirChunk: Region[] = [];
		for (;;) {
			let grew = false;
			while (i < ourRegions.length && ourRegions[i].baseStart <= end) {
				end = Math.max(end, ourRegions[i].baseEnd);
				ourChunk.push(ourRegions[i]);
				i += 1;
				grew = true;
			}
			while (j < theirRegions.length && theirRegions[j].baseStart <= end) {
				end = Math.max(end, theirRegions[j].baseEnd);
				theirChunk.push(theirRegions[j]);
				j += 1;
				grew = true;
			}
			if (!grew) break;
		}

		const baseText = baseLines.slice(start, end);
		const ourText = chunkText(baseLines, ourLines, ourChunk, start, end);
		const theirText = chunkText(baseLines, theirLines, theirChunk, start, end);

		if (linesEqual(ourText, theirText)) {
			out.push(...ourText); // 双方改成相同结果
		} else if (linesEqual(ourText, baseText)) {
			out.push(...theirText); // 我方未改
		} else if (linesEqual(theirText, baseText)) {
			out.push(...ourText); // 对方未改
		} else {
			conflicts += 1; // 真冲突：内容不进入结果，仅继续统计剩余冲突区
		}
		pos = end;
	}
	out.push(...baseLines.slice(pos));

	if (conflicts > 0) return { clean: false, conflictCount: conflicts };
	return { clean: true, text: out.join(""), conflictCount: 0 };
}

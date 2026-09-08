// 打开视图感知同步辅助：捕获缓冲快照 → 落盘未保存编辑 → 写盘后刷新视图
// - 快照规则：刷新仅当「当前缓冲 === 捕获时缓冲 且（原本干净或已成功保存）」，
//   处理期间用户继续输入则跳过（保留输入，由下一轮 Session 对账自然收敛）

import { App, MarkdownView } from "obsidian";

import { debugLog } from "./debug-log";
import { normalize } from "./excludes";

export interface OpenMarkdownViewState {
	view: MarkdownView;
	path: string; // normalize 后路径（刷新前校验视图未被切换/关闭）
	buffer: string; // 捕获时编辑缓冲快照（行尾归一化 \r\n→\n，与 CM 缓冲一致）
	dirty: boolean; // 捕获时 buffer ≠ 磁盘内容（磁盘读取失败保守取 true）
	saved: boolean; // saveDirtyOpenViews 已成功落盘
}

// normalizeEol 行尾归一化（仅内容比较用，勿用 excludes.normalize——它会改写内容中的反斜杠）
function normalizeEol(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

// openMarkdownViews 返回 path 对应的打开 markdown 视图（原 engine.hasOpenLeaf 的比对逻辑迁入）
export function openMarkdownViews(app: App, path: string): MarkdownView[] {
	const p = normalize(path);
	return app.workspace
		.getLeavesOfType("markdown")
		.map((leaf) => leaf.view)
		.filter((view): view is MarkdownView => view instanceof MarkdownView && view.file != null && normalize(view.file.path) === p);
}

// captureAllOpenViews 捕获全部打开 markdown 视图状态（Session 开始时统一落盘未保存编辑用）
export async function captureAllOpenViews(app: App): Promise<OpenMarkdownViewState[]> {
	const states: OpenMarkdownViewState[] = [];
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || view.file == null) continue;
		states.push(...(await captureOpenViews(app, normalize(view.file.path))));
	}
	return states;
}

// captureOpenViews 捕获打开视图状态：缓冲快照 + 与磁盘比对的脏标记
export async function captureOpenViews(app: App, path: string): Promise<OpenMarkdownViewState[]> {
	const p = normalize(path);
	const states: OpenMarkdownViewState[] = [];
	for (const view of openMarkdownViews(app, p)) {
		let buffer = "";
		try {
			buffer = normalizeEol(view.editor.getValue());
		} catch {
			continue; // 视图销毁中
		}
		let dirty = true;
		try {
			dirty = buffer !== normalizeEol(await app.vault.adapter.read(p));
		} catch {
			// 文件不存在（读失败）→ dirty 保持 true（保守）
		}
		states.push({ view, path: p, buffer, dirty, saved: false });
	}
	return states;
}

// saveDirtyOpenViews 仅对脏视图调 view.save() 把未保存编辑落盘（触发 modify 事件 → detector 正常入队 push）；
// 返回成功保存数。save 要求文件在磁盘（已被删时抛错），失败视图 saved=false 后续不会被覆盖
export async function saveDirtyOpenViews(app: App, states: OpenMarkdownViewState[]): Promise<number> {
	let saved = 0;
	for (const s of states) {
		if (!s.dirty) {
			continue;
		}
		try {
			await s.view.save();
			s.saved = true;
			saved++;
			debugLog.info("[pickpen] 已保存打开视图的未保存编辑");
		} catch (err) {
			debugLog.warn("[pickpen] 视图保存失败（文件可能已被删除）", err);
		}
	}
	return saved;
}

// refreshOpenViews 写盘后刷新打开视图，让用户立即看到同步。
// 快照规则：当前缓冲 === 捕获时缓冲 且（原本干净或已成功保存）才覆盖；处理期间用户继续输入 → 跳过。
// 检查与 setValue 之间无 await（同步执行，无 TOCTOU 窗口）。force 供主动恢复场景跳过该规则。
export async function refreshOpenViews(app: App, states: OpenMarkdownViewState[], content: Uint8Array, force = false): Promise<void> {
	if (states.length === 0) {
		return;
	}
	const decoded = normalizeEol(new TextDecoder("utf-8").decode(content));
	for (const s of states) {
		const view = s.view;
		if (view.file == null || normalize(view.file.path) !== s.path) {
			continue; // 处理期间视图已切换/关闭
		}
		let current = "";
		try {
			current = normalizeEol(view.editor.getValue());
		} catch {
			continue;
		}
		if (current === decoded) {
			continue; // 已一致，避免无谓 setValue（省一次写盘与事件）
		}
		if (!force && (current !== s.buffer || (s.dirty && !s.saved))) {
			debugLog.info("[pickpen] 跳过视图刷新（处理期间用户继续编辑）");
			continue;
		}
		try {
			view.editor.setValue(decoded);
			debugLog.info("[pickpen] 已刷新打开视图");
		} catch (err) {
			debugLog.warn("[pickpen] 视图刷新失败", err);
		}
	}
}

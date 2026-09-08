// LocalHint 目录级事件升级 forceAudit 测试（目录 rename/delete 影响整棵子树，
// 子文件事件可能跨轮/丢失，增量刷新会快照失真 → 升级全量审计兜底）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile, TFolder, type Vault } from "obsidian";
import { LocalHint } from "../src/sync/local-hint";
import type { ReconcileSession } from "../src/sync/session";

interface Handlers {
	[name: string]: (file: unknown, oldPath?: string) => void;
}

function makeHint(debounceMs: () => number = () => 2000) {
	const handlers: Handlers = {};
	const vault = {
		on: (event: string, cb: (file: unknown, oldPath?: string) => void) => {
			handlers[event] = cb;
			return { event, cb };
		},
	} as unknown as Vault;
	const session = {
		addDirty: vi.fn(),
		addDirtyRename: vi.fn(),
		requestRun: vi.fn(),
	} as unknown as ReconcileSession;
	const hint = new LocalHint(vault, session, debounceMs, () => {});
	hint.register();
	return { handlers, session, hint };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("目录级事件升级 forceAudit", () => {
	it("TFolder rename → 双路径标脏 + 防抖后 requestRun({forceAudit:true})", () => {
		vi.useFakeTimers();
		const { handlers, session } = makeHint();
		handlers.rename(Object.assign(new TFolder(), { path: "b" }), "a");
		vi.advanceTimersByTime(2500);
		expect(session.addDirtyRename).toHaveBeenCalledWith("a", "b");
		expect(session.requestRun).toHaveBeenCalledWith({ forceAudit: true });
	});

	it("TFolder delete → addDirty + 防抖后 requestRun({forceAudit:true})", () => {
		vi.useFakeTimers();
		const { handlers, session } = makeHint();
		handlers.delete(Object.assign(new TFolder(), { path: "a" }));
		vi.advanceTimersByTime(2500);
		expect(session.addDirty).toHaveBeenCalledWith("a");
		expect(session.requestRun).toHaveBeenCalledWith({ forceAudit: true });
	});

	it("TFile rename/delete 不升级：requestRun() 不带 forceAudit", () => {
		vi.useFakeTimers();
		const { handlers, session } = makeHint();
		handlers.rename(Object.assign(new TFile(), { path: "b.md" }), "a.md");
		vi.advanceTimersByTime(2500);
		expect(session.addDirtyRename).toHaveBeenCalledWith("a.md", "b.md");
		expect(session.requestRun).toHaveBeenCalledWith(undefined);
		handlers.delete(Object.assign(new TFile(), { path: "c.md" }));
		vi.advanceTimersByTime(2500);
		expect(session.requestRun).toHaveBeenLastCalledWith(undefined);
	});

	it("防抖窗口合并：目录事件与子文件事件只触发一次，forceAudit 标志保留", () => {
		vi.useFakeTimers();
		const { handlers, session } = makeHint();
		handlers.rename(Object.assign(new TFolder(), { path: "b" }), "a");
		vi.advanceTimersByTime(100); // 子文件事件随后到达（BFS 顺序）
		handlers.rename(Object.assign(new TFile(), { path: "b/x.md" }), "a/x.md");
		handlers.modify(Object.assign(new TFile(), { path: "b/x.md" }));
		vi.advanceTimersByTime(2500);
		expect(session.requestRun).toHaveBeenCalledTimes(1);
		expect(session.requestRun).toHaveBeenCalledWith({ forceAudit: true });
	});

	it("触发后标志复位：下一窗口纯文件事件不再带 forceAudit", () => {
		vi.useFakeTimers();
		const { handlers, session } = makeHint();
		handlers.delete(Object.assign(new TFolder(), { path: "a" }));
		vi.advanceTimersByTime(2500);
		expect(session.requestRun).toHaveBeenLastCalledWith({ forceAudit: true });
		handlers.modify(Object.assign(new TFile(), { path: "x.md" }));
		vi.advanceTimersByTime(2500);
		expect(session.requestRun).toHaveBeenCalledTimes(2);
		expect(session.requestRun).toHaveBeenLastCalledWith(undefined);
	});

	it("新事件使用最新的运行时防抖值", () => {
		vi.useFakeTimers();
		let debounceMs = 2000;
		const { handlers, session } = makeHint(() => debounceMs);
		handlers.modify(Object.assign(new TFile(), { path: "a.md" }));
		vi.advanceTimersByTime(1000);
		debounceMs = 5000; // 已启动的计时器不重排
		vi.advanceTimersByTime(999);
		expect(session.requestRun).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(session.requestRun).toHaveBeenCalledTimes(1);

		handlers.modify(Object.assign(new TFile(), { path: "a.md" }));
		vi.advanceTimersByTime(4999);
		expect(session.requestRun).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(session.requestRun).toHaveBeenCalledTimes(2);
	});
});

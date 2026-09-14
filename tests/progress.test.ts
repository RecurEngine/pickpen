import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressTracker, formatProgress, progressPercent } from "../src/sync/progress";
import { StatusRefresh } from "../src/status-refresh";
import { deriveStatus } from "../src/settings";
import { SyncState } from "../src/sync-state";
import type { PluginSettings } from "../src/types";

describe("进度展示", () => {
	it("并发乱序完成时保留最早仍在运行的路径，快照不会被后续操作修改", () => {
		const updates = vi.fn();
		const tracker = new ProgressTracker(3, updates);
		const a = tracker.start("笔记/a.md");
		const b = tracker.start("笔记/b.md");
		const c = tracker.start("笔记/c.md");
		const before = updates.mock.lastCall![0];
		b();
		expect(updates.mock.lastCall![0]).toEqual({ completed: 1, total: 3, activePaths: ["笔记/a.md", "笔记/c.md"] });
		expect(formatProgress({ phase: "downloading", ...updates.mock.lastCall![0] })).toEqual({
			text: "正在下载，已完成 1/3 项", path: "当前文件：笔记/a.md（另有 1 项正在处理）",
		});
		a();
		c();
		c();
		expect(updates.mock.lastCall![0]).toEqual({ completed: 3, total: 3, activePaths: [] });
		expect(before.activePaths).toHaveLength(3);
	});

	it("失败移除当前路径但不增加成功数", async () => {
		const updates = vi.fn();
		const tracker = new ProgressTracker(1, updates);
		await expect(tracker.track("失败.md", async () => { throw new Error("失败"); })).rejects.toThrow("失败");
		expect(updates.mock.lastCall![0]).toEqual({ completed: 0, total: 1, activePaths: [] });
	});

	it("未知总量只显示阶段，扫描和应用使用已处理文案", () => {
		expect(formatProgress({ phase: "remote", completed: 0, total: null, activePaths: [] })).toEqual({ text: "正在获取远端信息", path: "" });
		expect(formatProgress({ phase: "applying", completed: 2, total: 3, activePaths: [] }).text).toBe("正在应用本地变更，已处理 2/3 项");
	});

	it("重试期间保留错误或阻塞提示，进度仍在运行态中可用", () => {
		const state = new SyncState();
		state.update({ sessionRunning: true, lastError: "网络失败", progress: { phase: "uploading", completed: 1, total: 2, activePaths: ["笔记.md"] } });
		const settings = { accessToken: "token" } as PluginSettings;
		expect(deriveStatus(settings, state).text).toBe("同步出错：网络失败");
		expect(formatProgress(state.progress!).path).toBe("当前文件：笔记.md");
		state.update({ lastError: "", blockedPaths: ["大文件"] });
		expect(deriveStatus(settings, state).mod).toBe("yellow");
		expect(state.progress?.completed).toBe(1);
	});

	it("百分比向下取整，未全部完成不显示 100%，总量未知或为空不显示进度条", () => {
		const at = (completed: number, total: number | null) => progressPercent({ phase: "uploading", completed, total, activePaths: [] });
		expect(at(12, 40)).toBe(30);
		expect(at(0, 40)).toBe(0);
		expect(at(40, 40)).toBe(100);
		expect(at(999, 1000)).toBe(99); // floor 而非 round：打满 100% 必须等于阶段完成
		expect(at(3, 2)).toBe(100); // 越界夹住，宽度不越界
		expect(at(0, null)).toBeNull(); // 无计数阶段（preparing/remote/planning/…）
		expect(at(0, 0)).toBeNull(); // 总量为 0 可达：空仓库扫描、无下载内容
	});
});

describe("设置页刷新调度", () => {
	afterEach(() => vi.useRealTimers());
	it("同阶段高频通知合并，阶段切换和结束立即刷新并撤销旧定时器", () => {
		vi.useFakeTimers();
		const refresh = vi.fn();
		const scheduler = new StatusRefresh(refresh);
		scheduler.request("scanning");
		for (let i = 0; i < 100; i++) scheduler.request("scanning");
		expect(refresh).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(100);
		expect(refresh).toHaveBeenCalledTimes(2);
		scheduler.request("scanning");
		scheduler.request("uploading");
		expect(refresh).toHaveBeenCalledTimes(3);
		scheduler.request("uploading");
		scheduler.request("idle");
		vi.runAllTimers();
		expect(refresh).toHaveBeenCalledTimes(4);
	});
	it("关闭后不再执行刷新，重新打开可立即读取最新状态", () => {
		vi.useFakeTimers();
		const refresh = vi.fn();
		const scheduler = new StatusRefresh(refresh);
		scheduler.request("uploading");
		scheduler.request("uploading");
		scheduler.cancel();
		vi.runAllTimers();
		expect(refresh).toHaveBeenCalledTimes(1);
		scheduler.request("uploading");
		expect(refresh).toHaveBeenCalledTimes(2);
	});
});

// 手动同步回执文案（sync-result）：优先级与措辞，与设置页状态卡片保持一致。
import { describe, expect, it } from "vitest";

import { syncResultMessage, type SyncResultInput } from "../src/sync-result";

const base: SyncResultInput = {
	pausedReason: "",
	lastError: "",
	storageLimitExceeded: false,
	blockedCount: 0,
	conflictCount: 0,
	changed: false,
};

const input = (patch: Partial<SyncResultInput> = {}): SyncResultInput => ({ ...base, ...patch });

describe("手动同步回执文案", () => {
	it("无变化时报告已全部同步", () => {
		expect(syncResultMessage(input())).toBe("已全部同步（无变化）");
	});

	it("有内容变化时报同步完成", () => {
		expect(syncResultMessage(input({ changed: true }))).toBe("同步完成");
	});

	it("有文件被阻塞时在完成文案里点明数量", () => {
		expect(syncResultMessage(input({ changed: true, blockedCount: 2 }))).toBe("同步完成，但有 2 个文件被阻塞");
		expect(syncResultMessage(input({ blockedCount: 1 }))).toBe("同步完成，但有 1 个文件被阻塞");
	});

	it("有冲突副本时单独报，且与被阻塞并存时两者都报", () => {
		expect(syncResultMessage(input({ changed: true, conflictCount: 1 }))).toBe("同步完成，但有 1 个冲突副本待处理");
		// 无变化也要报：副本是存量，不该因为没有新变更就被吞掉
		expect(syncResultMessage(input({ conflictCount: 3 }))).toBe("同步完成，但有 3 个冲突副本待处理");
		expect(syncResultMessage(input({ changed: true, blockedCount: 2, conflictCount: 1 }))).toBe(
			"同步完成，但有 2 个文件被阻塞、1 个冲突副本待处理",
		);
	});

	it("错误态优先于阻塞与冲突副本", () => {
		expect(syncResultMessage(input({ lastError: "网络失败", blockedCount: 2, conflictCount: 1 }))).toBe("同步失败：网络失败");
	});

	it("暂停原因优先于其它状态（如未解锁）", () => {
		expect(
			syncResultMessage(input({ pausedReason: "仓库已加密，请输入密码解锁", lastError: "网络失败", changed: true })),
		).toBe("同步已暂停：仓库已加密，请输入密码解锁");
	});

	it("容量超限报暂停", () => {
		expect(syncResultMessage(input({ storageLimitExceeded: true, lastError: "云端存储已满，新改动暂时无法上传" }))).toBe(
			"同步已暂停：云端存储已满",
		);
	});

	it("失败原因统一成一份「同步失败：」前缀", () => {
		// 会话里的通用失败自带前缀
		expect(syncResultMessage(input({ lastError: "同步失败：网络不可达" }))).toBe("同步失败：网络不可达");
		// 令牌失效、容量超限是裸原因
		expect(syncResultMessage(input({ lastError: "令牌失效，请重新登录" }))).toBe("同步失败：令牌失效，请重新登录");
	});

	it("失败优先于阻塞与完成", () => {
		expect(syncResultMessage(input({ lastError: "同步失败：网络不可达", blockedCount: 3, changed: true }))).toBe(
			"同步失败：网络不可达",
		);
	});
});

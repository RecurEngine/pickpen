import { afterEach, describe, expect, it, vi } from "vitest";

import { debugLog } from "../src/debug-log";

describe("debugLog", () => {
	afterEach(() => {
		debugLog.setEnabled(false);
		vi.restoreAllMocks();
	});

	it("默认忽略非错误日志且不劫持 console", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		debugLog.setEnabled(false);
		debugLog.info("private plugin diagnostic");
		expect(info).not.toHaveBeenCalled();
		expect(debugLog.dump()).toHaveLength(0);
	});

	it("默认仍向 console 输出真实错误，但不保留诊断缓冲", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		debugLog.setEnabled(false);
		debugLog.error("request failed");
		expect(error).toHaveBeenCalledWith("request failed");
		expect(debugLog.dump()).toHaveLength(0);
	});

	it("仅在用户开启后记录插件主动输出的日志", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		debugLog.setEnabled(true);
		debugLog.info("sync completed");
		expect(info).toHaveBeenCalledWith("sync completed");
		expect(debugLog.dump()).toHaveLength(1);
		expect(debugLog.dump()[0]?.message).toBe("sync completed");
	});

	it("错误与对象只记录类型，不序列化其中的敏感值", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		debugLog.setEnabled(true);
		debugLog.error("sync failed", new Error("secret@example.com"), { accessToken: "secret-token" });
		expect(error).toHaveBeenCalledWith("sync failed [Error] [Object]");
		expect(debugLog.dump()[0]?.message).not.toContain("secret@example.com");
		expect(debugLog.dump()[0]?.message).not.toContain("secret-token");
	});
});

// 异常上报模块单测：脱敏、指纹稳定性、队列配额/持久化、上报防反馈环。

import { describe, expect, it, vi } from "vitest";

import { isExpectedError, normalizeError } from "../src/error-report/classify";
import { clientFingerprint, normalizeMessage } from "../src/error-report/fingerprint";
import { ErrorQueue, QUEUE_LIMIT, type EnqueueInput } from "../src/error-report/queue";
import { ErrorReporter } from "../src/error-report/reporter";
import { sanitizeMessage, sanitizeText, truncateUtf8 } from "../src/error-report/sanitize";
import type { QueuedReport, ReporterMeta } from "../src/error-report/types";
import { fnv1aHex, type KeyValueStore } from "../src/session-store";

const SECRETS = { vaultName: "MySecretVault", vaultBasePath: "/Users/alice/MySecretVault" };

function memoryKV(): KeyValueStore & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		},
		removeItem: (key) => {
			map.delete(key);
		},
	};
}

function input(message: string, overrides: Partial<EnqueueInput> = {}): EnqueueInput {
	return {
		phase: "sync",
		level: "error",
		errorName: "Error",
		message,
		stack: "",
		code: 0,
		httpStatus: 0,
		contextJson: "{}",
		deviceId: "dev-1",
		pluginVersion: "1.7.0",
		platform: "desktop",
		os: "macos",
		signedIn: true,
		vaultId: "9",
		network: false,
		...overrides,
	};
}

function meta(): ReporterMeta {
	return {
		deviceId: "dev-1",
		pluginVersion: "1.7.0",
		vaultId: "9",
		platform: "desktop",
		os: "macos",
		signedIn: true,
		vaultBound: true,
		encrypted: false,
		locked: false,
		syncRunning: false,
		pendingCount: 0,
		appVersion: "1.14.4",
		locale: "zh",
	};
}

function reporterWith(send: (items: QueuedReport[]) => Promise<{ accepted: number; retryAfterMs: number }>) {
	const kv = memoryKV();
	const reporter = new ErrorReporter(true);
	reporter.init({
		kv,
		scopeKey: "scope",
		secrets: () => SECRETS,
		meta,
		send,
	});
	reporter.setEnabled(true);
	return { reporter, kv };
}

describe("sanitize", () => {
	it("移除路径、邮箱、令牌、签名与仓库名", () => {
		const text = sanitizeText(
			"MySecretVault /Users/alice/MySecretVault/a.md alice@example.com Bearer abc.def " +
				"https://x/y?signature=secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh",
			SECRETS,
		);
		for (const place of ["<vault>", "<vault-path>", "<email>", "Bearer <token>", "signature=<redacted>", "<token>"]) {
			expect(text).toContain(place);
		}
		expect(text).not.toContain("alice");
		expect(text).not.toContain("secret");
	});

	it("消息额外移除文件名，栈保留函数名与行号", () => {
		expect(sanitizeMessage("读取 notes/日记.md 失败", SECRETS)).toContain("<file>");
		expect(sanitizeText("at sync (main.js:1:2)", SECRETS)).toContain("main.js:1:2");
	});

	it("按 UTF-8 边界截断", () => {
		const text = truncateUtf8("错".repeat(100), 10);
		expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(10);
		expect(text.length % 3).toBe(0);
	});
});

describe("fingerprint", () => {
	it("数字/UUID 归一化后指纹一致", () => {
		const a = clientFingerprint("sync", "Error", 12018, 0, normalizeMessage("vault-123 失败"), fnv1aHex);
		const b = clientFingerprint("sync", "Error", 12018, 0, normalizeMessage("vault-456 失败"), fnv1aHex);
		expect(a).toBe(b);
	});

	it("阶段/错误码/HTTP 状态不同则指纹不同", () => {
		const base = clientFingerprint("sync", "Error", 1, 0, "x", fnv1aHex);
		expect(clientFingerprint("login", "Error", 1, 0, "x", fnv1aHex)).not.toBe(base);
		expect(clientFingerprint("sync", "Error", 2, 0, "x", fnv1aHex)).not.toBe(base);
		expect(clientFingerprint("sync", "Error", 1, 503, "x", fnv1aHex)).not.toBe(base);
	});
});

describe("classify", () => {
	it("预期错误码不上报", () => {
		expect(isExpectedError({ code: 12018 })).toBe(true);
		expect(isExpectedError({ code: 11002 })).toBe(true);
		expect(isExpectedError({ code: 10001 })).toBe(false);
		expect(isExpectedError(new Error("boom"))).toBe(false);
	});

	it("直传 HTTP 错误提取状态码", () => {
		const err = Object.assign(new Error("直下失败（HTTP 503）"), { name: "DirectTransferHttpError", status: 503 });
		expect(normalizeError(err).httpStatus).toBe(503);
	});
});

describe("ErrorQueue", () => {
	it("入队并持久化，重启后可读回", () => {
		const kv = memoryKV();
		let now = 1_700_000_000_000;
		const queue = new ErrorQueue(kv, "q", () => now);
		expect(queue.enqueue(input("boom"))).not.toBeNull();
		expect(queue.pending(now)).toHaveLength(1);

		now += 1_000;
		const reloaded = new ErrorQueue(kv, "q", () => now);
		expect(reloaded.size()).toBe(1);
	});

	it("10 分钟内同指纹合并计数", () => {
		let now = 1_700_000_000_000;
		const queue = new ErrorQueue(memoryKV(), "q", () => now);
		expect(queue.enqueue(input("same"))).not.toBeNull();
		now += 60_000;
		expect(queue.enqueue(input("same"))).toBeNull();
		expect(queue.pending(now)[0].suppressedCount).toBe(1);
	});

	it("同指纹前 3 条全报，之后每 10 条采样 1 条", () => {
		let now = 1_700_000_000_000;
		const queue = new ErrorQueue(memoryKV(), "q", () => now);
		const accepted: number[] = [];
		for (let i = 1; i <= 13; i++) {
			now += 11 * 60 * 1000; // 越过 10 分钟去重窗口
			if (queue.enqueue(input("sampled"))) accepted.push(i);
		}
		expect(accepted).toEqual([1, 2, 3, 13]);
	});

	it("队列上限 30 条，丢最旧", () => {
		let now = 1_700_000_000_000;
		const queue = new ErrorQueue(memoryKV(), "q", () => now);
		for (let i = 0; i < 40; i++) {
			now += 11 * 60 * 1000;
			// 本用例只验证队列上限：把每会话/每日配额清零，避免先被会话上限截断。
			queue.snapshot().sessionCount = 0;
			queue.snapshot().dayCount = 0;
			// 消息用纯字母区分：数字会被归一化成 <n>，导致所有条目落成同一指纹。
			queue.enqueue(input("z".repeat(i + 1)));
		}
		expect(queue.size()).toBe(QUEUE_LIMIT);
		expect(queue.pending(now)[0].message).toBe("z".repeat(11));
	});

	it("网络类错误 6 小时窗口最多 3 条", () => {
		let now = 1_700_000_000_000;
		const queue = new ErrorQueue(memoryKV(), "q", () => now);
		let accepted = 0;
		for (let i = 0; i < 5; i++) {
			now += 11 * 60 * 1000;
			if (queue.enqueue(input(`network-${i}`, { network: true }))) accepted++;
		}
		expect(accepted).toBe(3);
	});

	it("失败重试走退避，未到期不再进入待发", () => {
		let now = 1_700_000_000_000;
		const queue = new ErrorQueue(memoryKV(), "q", () => now);
		const report = queue.enqueue(input("retry"));
		queue.markFailed([report!.reportId], 0);
		expect(queue.pending(now)).toHaveLength(0);
		now += 60_000;
		expect(queue.pending(now)).toHaveLength(1);
	});

	it("关闭开关清空持久化数据", () => {
		const kv = memoryKV();
		const queue = new ErrorQueue(kv, "q", () => Date.now());
		queue.enqueue(input("boom"));
		queue.clear();
		expect(queue.size()).toBe(0);
		expect(kv.map.size).toBe(0);
	});
});

describe("ErrorReporter", () => {
	it("采集时脱敏，发送失败保留队列且不外抛", async () => {
		const sent: QueuedReport[] = [];
		const send = vi.fn(async (items: QueuedReport[]) => {
			sent.push(...items);
			throw new Error("offline");
		});
		const { reporter } = reporterWith(send);
		reporter.capture("sync", new Error("读取 /Users/alice/MySecretVault/笔记.md 失败"));
		await reporter.flush();

		expect(send).toHaveBeenCalledTimes(1);
		expect(sent[0].message).toContain("<vault-path>");
		expect(sent[0].message).not.toContain("alice");

		// 退避期内不再重发
		await reporter.flush();
		expect(send).toHaveBeenCalledTimes(1);
		reporter.dispose();
	});

	it("预期错误不入队", async () => {
		const send = vi.fn(async () => ({ accepted: 1, retryAfterMs: 0 }));
		const { reporter } = reporterWith(send);
		reporter.capture("sync", Object.assign(new Error("snapshot changed"), { code: 12015 }));
		await reporter.flush();
		expect(send).not.toHaveBeenCalled();
		reporter.dispose();
	});

	it("Unimplemented 后停止本会话上报", async () => {
		const send = vi.fn(async () => {
			throw Object.assign(new Error("unimplemented"), { code: 12 });
		});
		const { reporter } = reporterWith(send);
		reporter.capture("sync", new Error("boom"));
		await reporter.flush();
		expect(reporter.isEnabled()).toBe(false);

		reporter.capture("sync", new Error("again"));
		await reporter.flush();
		expect(send).toHaveBeenCalledTimes(1);
		reporter.dispose();
	});

	it("关闭开关后不再采集", async () => {
		const send = vi.fn(async () => ({ accepted: 1, retryAfterMs: 0 }));
		const { reporter } = reporterWith(send);
		reporter.setEnabled(false);
		reporter.capture("sync", new Error("boom"));
		await reporter.flush();
		expect(send).not.toHaveBeenCalled();
		reporter.dispose();
	});
});

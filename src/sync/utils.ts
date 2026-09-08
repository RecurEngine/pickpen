// 同步模块共用工具：有限并发 map、事件循环让出（spec §10.1）

/** 有限并发 map（stat/读内容/上传下载批量并发用；从旧 reconcile.ts 迁入） */
export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * 让出事件循环控制（spec §10.1：每处理 100 个 entry 或连续执行 50ms 必须让出一次）。
 * 注入点形式：循环中按计数/时间调用，测试可替换为计数器。
 */
export function createYieldControl(yieldFn: () => Promise<void> = yieldToEventLoop) {
	let count = 0;
	let lastYield = Date.now();
	return {
		async tick(every = 100, everyMs = 50) {
			count++;
			if (count % every === 0 || Date.now() - lastYield >= everyMs) {
				lastYield = Date.now();
				await yieldFn();
			}
		},
		get yields() {
			return count;
		},
	};
}

export type YieldControl = ReturnType<typeof createYieldControl>;

/** 让出一帧（setTimeout 0） */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 随机退避毫秒（spec §10：指数退避 + ±10% 抖动，最大 5 分钟） */
export function backoffMs(attempt: number, baseMs = 20_000, maxMs = 5 * 60_000): number {
	const exp = Math.min(maxMs, baseMs * 2 ** attempt);
	const jitter = exp * (0.9 + Math.random() * 0.2);
	return Math.round(jitter);
}

/** base64 → Uint8Array（pending 与 proto 互转用） */
export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Uint8Array → base64 */
export function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

/** Uint8Array → ArrayBuffer（Obsidian adapter.writeBinary 入参） */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

/** RFC 4122 v4 UUID（file_id 稳定身份；环境不支持 crypto.randomUUID 时手写 fallback） */
export function newUUID(): string {
	try {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
			return crypto.randomUUID();
		}
	} catch {
		// fallthrough 到手写实现
	}
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

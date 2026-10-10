// 同步模块共用工具：有限并发 map、事件循环让出（spec §10.1）

/** 内容处理的内存预算（在途字节数上限）。并发窗口按字节限流而不是按条目数：
 *  同样「4 个并发」，一批 100MB 附件与一批 1KB 笔记的内存开销差五个数量级。 */
export const CONTENT_BUDGET = { desktop: 96 * 1024 * 1024, mobile: 32 * 1024 * 1024 } as const;

/** stat 缺失时按此估算内容体积（宁可少并发，不要突发大内存） */
export const UNKNOWN_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * 有限并发 map（stat/读内容/上传下载批量并发用；从旧 reconcile.ts 迁入）。
 * 传 budget 时额外按在途字节数限流：单个条目超过整个预算时独占运行（在途归零才准入），
 * 大文件因此天然串行、不与其他任务叠加内存。结果始终按输入顺序返回。
 */
export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
	budget?: { sizeOf: (item: T) => number; budgetBytes: number },
): Promise<R[]> {
	const results = new Array<R>(items.length);
	const maxActive = Math.max(1, limit);
	const sizeOf = budget?.sizeOf;
	const budgetBytes = budget?.budgetBytes ?? 0;
	let next = 0;
	let active = 0;
	let activeBytes = 0;
	let failed = false;

	const canAdmit = (size: number): boolean => {
		if (active >= maxActive) return false;
		if (!sizeOf) return true;
		if (active === 0) return true; // 独占通道：够大就让它一个人跑
		return activeBytes + size <= budgetBytes;
	};

	await new Promise<void>((resolve, reject) => {
		const pump = (): void => {
			if (failed) return;
			while (next < items.length && canAdmit(sizeOf ? sizeOf(items[next]) : 0)) {
				const i = next++;
				const size = sizeOf ? sizeOf(items[i]) : 0;
				active++;
				activeBytes += size;
				fn(items[i])
					.then(
						(result) => {
							results[i] = result;
						},
						(err: unknown) => {
							failed = true; // 停止准入与调度；在途任务自然收敛，不再发起新请求
							// 原样透出业务错误（Error 及其附加字段如 code 都要保留），非 Error 兜底包装
							reject(err instanceof Error ? err : new Error(String(err)));
						},
					)
					.finally(() => {
						active--;
						activeBytes -= size;
						pump();
					});
			}
			if (active === 0 && next >= items.length) resolve();
		};
		pump();
	});
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

/** 让出一帧（window.setTimeout 0） */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
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

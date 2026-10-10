// mapConcurrent 的字节预算限流（spec §10.1 的并发口径按内容体积收口）：
// 准入看「在途字节数」而不是「在途条目数」，单个条目超过整个预算时独占运行，
// 结果顺序与错误传播语义与原来按条目数限流完全一致。
import { describe, expect, it } from "vitest";

import { CONTENT_BUDGET, mapConcurrent, UNKNOWN_SIZE_BYTES } from "../src/sync/utils";

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** 让出宏任务：冲洗本轮所有微任务（调度器全部在微任务里推进） */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mapConcurrent", () => {
	it("结果按输入顺序返回（与完成顺序无关）", async () => {
		const out = await mapConcurrent([1, 2, 3], 3, async (n) => {
			await tick();
			return n * 10;
		});
		expect(out).toEqual([10, 20, 30]);
	});

	it("不传预算时并发不超过条目数上限", async () => {
		let active = 0;
		let peak = 0;
		await mapConcurrent([1, 2, 3, 4, 5], 2, async (n) => {
			active++;
			peak = Math.max(peak, active);
			await tick();
			active--;
			return n;
		});
		expect(peak).toBe(2);
	});

	it("空输入立即返回", async () => {
		await expect(mapConcurrent([], 4, async () => 1)).resolves.toEqual([]);
	});

	it("按在途字节准入：小条目可并存，超出预算的条目只等不抢", async () => {
		// 预算 25：a(10)+b(10) 可并存；c(100) 放不下 → 等两个在途的都结束才独占运行
		const items = [
			{ id: "a", size: 10 },
			{ id: "b", size: 10 },
			{ id: "c", size: 100 },
			{ id: "d", size: 10 },
		];
		const gates = new Map(items.map((it) => [it.id, deferred()]));
		const events: string[] = [];
		let activeBytes = 0;
		let peakBytes = 0;
		let cOverlapped = false;
		const run = mapConcurrent(
			items,
			4,
			async (it) => {
				if (it.id === "c" && activeBytes > 0) cOverlapped = true;
				activeBytes += it.size;
				peakBytes = Math.max(peakBytes, activeBytes);
				events.push(`start:${it.id}`);
				await gates.get(it.id)!.promise;
				activeBytes -= it.size;
				events.push(`end:${it.id}`);
				return it.id;
			},
			{ sizeOf: (it) => it.size, budgetBytes: 25 },
		);

		await tick();
		expect(events).toEqual(["start:a", "start:b"]); // 条目数上限放宽到 4，仍只放两个（字节预算）
		gates.get("a")!.resolve();
		await tick();
		expect(events).toEqual(["start:a", "start:b", "end:a"]); // b 在途，c 放不下 → 不新准入
		gates.get("b")!.resolve();
		await tick();
		expect(events).toEqual(["start:a", "start:b", "end:a", "end:b", "start:c"]);
		gates.get("c")!.resolve();
		await tick();
		expect(events).toContain("start:d");
		gates.get("d")!.resolve();

		await expect(run).resolves.toEqual(["a", "b", "c", "d"]);
		expect(cOverlapped).toBe(false); // 超预算的大文件独占通道，不与其他任务叠加
		expect(peakBytes).toBeLessThanOrEqual(CONTENT_BUDGET.desktop); // 峰值不超过独占项体积
	});

	it("体积未知按保守估算计入预算", async () => {
		const sizeOf = () => UNKNOWN_SIZE_BYTES;
		let active = 0;
		let peak = 0;
		await mapConcurrent(
			[1, 2, 3],
			8,
			async (n) => {
				active++;
				peak = Math.max(peak, active);
				await tick();
				active--;
				return n;
			},
			{ sizeOf, budgetBytes: UNKNOWN_SIZE_BYTES * 2 },
		);
		expect(peak).toBe(2);
	});

	it("错误原样抛出（保留附加字段），且出错后不再准入新条目", async () => {
		const started: number[] = [];
		const gate = deferred();
		const run = mapConcurrent([1, 2, 3, 4], 1, async (n) => {
			started.push(n);
			if (n === 1) {
				await gate.promise;
				throw Object.assign(new Error("首个失败"), { code: 12015 });
			}
			return n;
		});
		await tick();
		expect(started).toEqual([1]);
		gate.resolve();
		await expect(run).rejects.toMatchObject({ code: 12015 });
		await tick();
		expect(started).toEqual([1]); // 失败后队列不再继续
	});
});

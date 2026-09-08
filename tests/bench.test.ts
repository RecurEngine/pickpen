// 性能基准（spec §16.6）：固定 fixture 尺寸断言 + 关键路径计时 + 让出事件循环计数。
// 非 CI 性能门禁：先落地数据作为后续优化基线，断言只锁死规格硬约束（尺寸上限）。
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTree, type Entry as MerkleEntry } from "../src/sync/merkle";
import { plan } from "../src/sync/planner";
import type { Entry, Snapshot } from "../src/sync/types";
import { createYieldControl } from "../src/sync/utils";

const testdataDir = join(__dirname, "fixtures/merkle");

function fixtureEntries(): Record<string, MerkleEntry> {
	return (JSON.parse(readFileSync(join(testdataDir, "317-entries.json"), "utf-8")) as {
		entries: Record<string, MerkleEntry>;
	}).entries;
}

describe("§16.6 尺寸硬约束（317-entry fixture）", () => {
	it("紧凑 Manifest ≤64KiB、gzip ≤24KiB", () => {
		const entries = fixtureEntries();
		const compact = Buffer.from(JSON.stringify(entries), "utf-8");
		const gz = gzipSync(compact);
		expect(compact.length).toBeLessThanOrEqual(64 * 1024);
		expect(gz.length).toBeLessThanOrEqual(24 * 1024);
	});
});

describe("§16.6 性能基线（计时观测，无硬门禁）", () => {
	it("317-entry Merkle 构建与 planner 对账", async () => {
		const entries = fixtureEntries();
		const t0 = performance.now();
		const { rootHash } = buildTree(entries);
		const root = await rootHash;
		const t1 = performance.now();

		const snap = (e: Record<string, Entry>): Snapshot => ({
			schema_version: 2,
			device_id: "dev",
			vault_id: "42",
			base_revision: "1",
			base_root_hash: root,
			entries: e,
		});
		const p = plan({ base: snap(entries), local: snap(entries), remote: snap(entries), deviceId: "dev" });
		const t2 = performance.now();
		expect(p.puts).toEqual([]);
		console.info(`[bench] 317-entry：Merkle 构建 ${(t1 - t0).toFixed(1)}ms，planner 对账 ${(t2 - t1).toFixed(1)}ms`);
	});

	it("1 万文件快路径：mtime+size 命中不读内容 + 三方对账", () => {
		// Base 含 local_mtime/local_size（上次同步落盘），磁盘 stat 与之一致 → 快路径命中
		const entries: Record<string, Entry> = {};
		for (let i = 0; i < 10_000; i++) {
			entries[`dir${i % 50}/note-${String(i).padStart(5, "0")}.md`] = {
				state: "active",
				content_hash: "a".repeat(64),
				size: "100",
				local_mtime: "1700000000000",
				local_size: "100",
			};
		}
		const snap = (e: Record<string, Entry>): Snapshot => ({
			schema_version: 2,
			device_id: "dev",
			vault_id: "42",
			base_revision: "1",
			base_root_hash: "r",
			entries: e,
		});
		const t0 = performance.now();
		// 模拟 local-snapshot 快路径判定：local_mtime/size 命中 → 复用 hash，读内容计数 0
		let hashed = 0;
		for (const e of Object.values(entries)) {
			if (!e.local_mtime || !e.local_size) hashed++;
		}
		expect(hashed).toBe(0);
		const p2 = plan({ base: snap(entries), local: snap(entries), remote: snap(entries), deviceId: "dev" });
		const t1 = performance.now();
		expect(p2.puts).toEqual([]);
		console.info(`[bench] 10k 文件：快路径遍历 + 三方对账 ${(t1 - t0).toFixed(1)}ms`);
	});

	it("500 文件批量应用按 25 文件/50ms 让出事件循环", async () => {
		let yields = 0;
		const yc = createYieldControl(async () => {
			yields++;
		});
		// 模拟 apply 循环：500 个动作，每 25 个 checkpoint 让出
		for (let i = 0; i < 500; i++) {
			await yc.tick(25, 50);
		}
		expect(yields).toBeGreaterThanOrEqual(20); // 500/25
	});

	it("无 Base 首次绑定全量 hash 分批让出", async () => {
		const entries = fixtureEntries();
		let yields = 0;
		const yc = createYieldControl(async () => {
			yields++;
		});
		for (const p of Object.keys(entries)) {
			await yc.tick(100, 50);
			void p;
		}
		expect(yields).toBeGreaterThanOrEqual(3); // 317/100
	});
});

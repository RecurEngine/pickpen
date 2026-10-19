// BaseStore（Base Snapshot Store）与 PendingStore 测试：
// 三重校验、原子写、损坏 → 安全 Bootstrap（spec §6.4/§9.4）
import { describe, expect, it } from "vitest";
import { BaseStore } from "../src/sync/base-store";
import { PendingStore } from "../src/sync/pending-store";
import type { Plugin } from "obsidian";
import type { Snapshot } from "../src/sync/types";

/** mock adapter：插件文件（sync-index/pending）内存读写 + 磁盘文件（vault 内）固定 stat */
function mockAdapter(initial: Record<string, string> = {}, diskFiles: string[] = ["a.md"]) {
	const files = { ...initial };
	const writes: string[] = [];
	return {
		files,
		writes,
		adapter: {
			async read(path: string): Promise<string> {
				if (!(path in files)) throw new Error("not found");
				return files[path];
			},
			async write(path: string, content: string): Promise<void> {
				files[path] = content;
				writes.push(path);
			},
			async remove(path: string): Promise<void> {
				delete files[path];
				writes.push(`remove:${path}`);
			},
			async rename(from: string, to: string): Promise<void> {
				if (!(from in files)) throw new Error("rename source missing");
				if (to in files) throw new Error("rename target exists");
				files[to] = files[from];
				delete files[from];
				writes.push(`rename:${from}->${to}`);
			},
			async stat(path: string): Promise<{ mtime: number; size: number } | null> {
				if (diskFiles.includes(path)) return { mtime: 1700000000000, size: 123 };
				if (path in files) return { mtime: 1700000000000, size: files[path].length };
				return null;
			},
		},
	};
}

function mockPlugin(adapter: unknown): Plugin {
	return {
		app: { vault: { adapter } },
		manifest: { dir: ".obsidian/plugins/pickpen" },
	} as unknown as Plugin;
}

function baseSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		schema_version: 2,
		device_id: "dev-1",
		vault_id: "42",
		base_revision: "3",
		base_root_hash: "root-abc",
		entries: {
			"a.md": { state: "active", content_hash: "a".repeat(64), size: "10" },
		},
		...overrides,
	};
}

describe("BaseStore", () => {
	it("损坏/device 不匹配 → corrupt（安全 Bootstrap，不把空 Base 当远端全删）", async () => {
		const m = mockAdapter({ ".obsidian/plugins/pickpen/sync-base.json": `{"deviceId":"other"}` });
		const store = new BaseStore(mockPlugin(m.adapter), "dev-1");
		expect(await store.load()).toBe("corrupt");
		expect(store.getBase()).toBeNull();
	});

	it("schema v2 结构非法 → corrupt", async () => {
		const m = mockAdapter({ ".obsidian/plugins/pickpen/sync-base.json": `{"schema_version":1}` });
		const store = new BaseStore(mockPlugin(m.adapter), "dev-1");
		expect(await store.load()).toBe("corrupt");
	});

	it("只有旧 sync-index.json 时不兼容读取，按 no-base 处理", async () => {
		const m = mockAdapter({ ".obsidian/plugins/pickpen/sync-index.json": JSON.stringify(baseSnapshot()) });
		const store = new BaseStore(mockPlugin(m.adapter), "dev-1");
		expect(await store.load()).toBe("no-base");
		expect(store.getBase()).toBeNull();
	});

	it("正常加载", async () => {
		const snap = baseSnapshot();
		const m = mockAdapter({ ".obsidian/plugins/pickpen/sync-base.json": JSON.stringify(snap) });
		const store = new BaseStore(mockPlugin(m.adapter), "dev-1");
		expect(await store.load()).toBe("ok");
		expect(store.getBase()?.base_root_hash).toBe("root-abc");
	});

	it("saveBase 写盘前重新 stat 记录实际 mtime/size，且走原子写（临时文件 + rename）", async () => {
		const m = mockAdapter();
		const store = new BaseStore(mockPlugin(m.adapter), "dev-1");
		await store.saveBase(baseSnapshot());
		const raw = m.files[".obsidian/plugins/pickpen/sync-base.json"];
		const parsed = JSON.parse(raw) as Snapshot;
		// 磁盘 stat 的 mtime/size 覆盖占位值（mock stat 返回 1700000000000/123）
		expect(parsed.entries["a.md"].local_mtime).toBe("1700000000000");
		expect(parsed.entries["a.md"].local_size).toBe("123");
		expect(m.writes.some((w) => w.endsWith(".tmp"))).toBe(true);
		expect(m.writes.some((w) => w.startsWith("rename:"))).toBe(true);
	});

	it("unverified 的条目不带 local_* 快路径字段（被排除/被阻塞路径不得冒充已校验）", async () => {
		const m = mockAdapter({}, ["excluded.txt", "kept.md"]); // 两个路径磁盘上都存在
		const store = new BaseStore(mockPlugin(m.adapter), "dev-1");
		await store.saveBase(
			baseSnapshot({
				entries: {
					"excluded.txt": { state: "active", content_hash: "a".repeat(64), size: "1" },
					"kept.md": { state: "active", content_hash: "b".repeat(64), size: "1" },
				},
			}),
			{ unverified: (path) => path === "excluded.txt" },
		);
		const parsed = JSON.parse(m.files[".obsidian/plugins/pickpen/sync-base.json"]) as Snapshot;
		// 被排除路径：下一轮必须重新读盘算哈希，否则期间的本地改动会被快路径永久漏掉
		expect(parsed.entries["excluded.txt"].local_mtime).toBeUndefined();
		expect(parsed.entries["excluded.txt"].content_hash).toBe("a".repeat(64)); // 内容哈希保留（远端状态）
		expect(parsed.entries["kept.md"].local_mtime).toBe("1700000000000");
	});

	it("outOfScope 的条目带 out_of_scope 标记（planner 据此按 Bootstrap 裁决），离开范围后清掉", async () => {
		const m = mockAdapter({}, ["plugin.js"]);
		const store = new BaseStore(mockPlugin(m.adapter), "dev-1");
		const entry = { state: "active" as const, content_hash: "a".repeat(64), size: "1" };
		await store.saveBase(baseSnapshot({ entries: { "plugin.js": entry } }), {
			unverified: () => true,
			outOfScope: () => true,
		});
		let parsed = JSON.parse(m.files[".obsidian/plugins/pickpen/sync-base.json"]) as Snapshot;
		// 远端回声：内容哈希保留（目标树要用），但不带 local_*，且标记为「不在范围内」
		expect(parsed.entries["plugin.js"].out_of_scope).toBe(true);
		expect(parsed.entries["plugin.js"].content_hash).toBe("a".repeat(64));
		expect(parsed.entries["plugin.js"].local_mtime).toBeUndefined();

		// 开关打开后该路径进入范围：标记必须清掉，否则用户后续的本地修改只会生成冲突副本
		await store.saveBase(baseSnapshot({ entries: { "plugin.js": entry } }), {
			unverified: () => false,
			outOfScope: () => false,
		});
		parsed = JSON.parse(m.files[".obsidian/plugins/pickpen/sync-base.json"]) as Snapshot;
		expect(parsed.entries["plugin.js"].out_of_scope).toBeUndefined();
		expect(parsed.entries["plugin.js"].local_mtime).toBe("1700000000000");
	});

	it("卸载落盘（未提供 outOfScope）沿用条目上已有的 out_of_scope 标记", async () => {
		const m = mockAdapter({}, ["plugin.js"]);
		const store = new BaseStore(mockPlugin(m.adapter), "dev-1");
		const snap = baseSnapshot({
			entries: {
				"plugin.js": {
					state: "active" as const,
					content_hash: "a".repeat(64),
					size: "1",
					out_of_scope: true,
				},
			},
		});
		await store.saveBase(snap);
		const parsed = JSON.parse(m.files[".obsidian/plugins/pickpen/sync-base.json"]) as Snapshot;
		expect(parsed.entries["plugin.js"].out_of_scope).toBe(true);
	});

	it("老基线（无 scope_marked）载入时一次性迁移：缺 local_* 的 active 条目按远端回声标注", async () => {
		const m = mockAdapter({
			".obsidian/plugins/pickpen/sync-base.json": JSON.stringify(
				baseSnapshot({
					entries: {
						// 被选择性同步排除的路径：写基线时没校验过本地内容（无 local_*）
						"plugin.js": { state: "active", content_hash: "a".repeat(64), size: "1" },
						// 已校验的路径：带 local_*，不是回声
						"note.md": {
							state: "active",
							content_hash: "b".repeat(64),
							size: "1",
							local_mtime: "1",
							local_size: "1",
						},
					},
				}),
			),
		});
		const store = new BaseStore(mockPlugin(m.adapter), "dev-1");
		expect(await store.load()).toBe("ok");
		const entries = store.getBase()!.entries;
		expect(entries["plugin.js"].out_of_scope).toBe(true);
		expect(entries["note.md"].out_of_scope).toBeUndefined();
	});

	it("磁盘不存在的 active 条目清除 local_* 快路径字段", async () => {
		const m = mockAdapter();
		const store = new BaseStore(mockPlugin(m.adapter), "dev-1");
		await store.saveBase(
			baseSnapshot({
				entries: {
					"gone.md": { state: "active", content_hash: "b".repeat(64), size: "1" },
				},
			}),
		);
		const parsed = JSON.parse(m.files[".obsidian/plugins/pickpen/sync-base.json"]) as Snapshot;
		expect(parsed.entries["gone.md"].local_mtime).toBeUndefined();
	});
});

describe("PendingStore", () => {
	it("writePrepared/markCommitted/markApplying/clear 全周期 + 原子写", async () => {
		const m = mockAdapter();
		const store = new PendingStore(mockPlugin(m.adapter));
		await store.writePrepared({
			schema_version: 2,
			vault_id: "42",
			base_revision: "1",
			base_root_hash: "r1",
			target_root_hash: "r2",
			apply_actions: [{ kind: "write", path: "a.md", content_hash: "a".repeat(64), size: "1" }],
			created_at: "2026-08-28T00:00:00Z",
		});
		expect(store.getPending()?.phase).toBe("prepared");
		await store.markCommitted("2");
		expect(store.getPending()?.phase).toBe("committed");
		expect(store.getPending()?.target_revision).toBe("2");
		await store.markApplying();
		expect(store.getPending()?.phase).toBe("applying");
		await store.clear();
		expect(store.getPending()).toBeNull();
		expect(".obsidian/plugins/pickpen/sync-pending-v2.json" in m.files).toBe(false);
	});

	it("损坏的 pending 丢弃", async () => {
		const m = mockAdapter({ ".obsidian/plugins/pickpen/sync-pending-v2.json": "not-json{" });
		const store = new PendingStore(mockPlugin(m.adapter));
		expect(await store.load()).toBeNull();
	});
});

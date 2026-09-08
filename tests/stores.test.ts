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

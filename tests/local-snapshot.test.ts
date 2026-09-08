// Local Snapshot 目录物化（统一规则）与 renameHints 前缀展开测试。
// fake vault 以 TFile/TFolder 实例驱动（obsidian-stub 的空类 + Object.assign 赋 path/stat）。
import { describe, expect, it } from "vitest";
import { TFile, TFolder, type Vault } from "obsidian";
import { sha256Hex } from "../src/sync/content-hash";
import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import type { Entry, Snapshot } from "../src/sync/types";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function tf(path: string, content: string): TFile {
	return Object.assign(new TFile(), {
		path,
		stat: { mtime: 1, size: enc(content).byteLength },
	}) as TFile;
}

function tdir(path: string): TFolder {
	return Object.assign(new TFolder(), { path }) as TFolder;
}

function fakeVault(files: TFile[], dirs: TFolder[], contents: Map<string, Uint8Array>): Vault {
	return {
		getFiles: () => files,
		getAllLoadedFiles: () => [...dirs, ...files] as TFile[],
		getFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
		getAbstractFileByPath: (p: string) => [...dirs, ...files].find((f) => f.path === p) ?? null,
		adapter: { readBinary: async (p: string) => contents.get(p) ?? new Uint8Array(0) },
	} as unknown as Vault;
}

const dirEntry = (file_id: string): Entry => ({ state: "active", kind: 2, file_id });

function base(entries: Record<string, Entry>): Snapshot {
	return {
		schema_version: 2,
		device_id: "dev-1",
		vault_id: "42",
		base_revision: "1",
		base_root_hash: "r1",
		entries,
	};
}

function refreshCtx(over: {
	vault: Vault;
	base?: Snapshot | null;
	dirtyPaths?: string[];
	renameHints?: [string, string][];
	forceAudit?: boolean;
	maxFileSizeBytes?: number;
}) {
	return {
		vault: over.vault,
		base: over.base ?? null,
		dirtyPaths: over.dirtyPaths ? new Set(over.dirtyPaths) : undefined,
		renameHints: over.renameHints ? new Map(over.renameHints) : undefined,
		forceAudit: over.forceAudit ?? false,
		extraExcludes: [] as string[],
		caseInsensitive: false,
		isMobile: false,
		maxFileSizeBytes: over.maxFileSizeBytes ?? 30 * 1024 * 1024,
	};
}

describe("目录物化（统一规则：磁盘存在的目录一律 active dir entry）", () => {
	it("使用服务端动态上限阻塞大文件且不把 Base 误判为删除", async () => {
		const content = enc("123456");
		const b = new LocalSnapshotBuilder();
		const previous = base({
			"large.md": { state: "active", content_hash: "old", size: "3", file_id: "550e8400-e29b-41d4-a716-446655440099" },
		});
		const res = await b.refresh(refreshCtx({
			vault: fakeVault([tf("large.md", "123456")], [], new Map([["large.md", content]])),
			base: previous,
			forceAudit: true,
			maxFileSizeBytes: 5,
		}));
		expect(res.blockedPaths).toContain("large.md");
		expect(res.snapshot.entries["large.md"]).toBeUndefined();
		const unchanged = await b.refresh(refreshCtx({ vault: fakeVault([], [], new Map()) }));
		expect(unchanged.blockedPaths).toContain("large.md");
	});

	it("fullAudit：非空目录物化 active dir，文件条目不受影响", async () => {
		const content = enc("abc");
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeVault([tf("a/x.md", "abc")], [tdir("a")], new Map([["a/x.md", content]])),
				forceAudit: true,
			}),
		);
		const e = res.snapshot.entries;
		expect(e["a"]).toMatchObject({ state: "active", kind: 2 });
		expect(e["a"].file_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(e["a/x.md"]).toMatchObject({ state: "active", content_hash: await sha256Hex(content), size: "3" });
	});

	it("fullAudit：空目录物化 active dir（既有语义）", async () => {
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeVault([], [tdir("empty")], new Map()),
				forceAudit: true,
			}),
		);
		expect(res.snapshot.entries["empty"]).toMatchObject({ state: "active", kind: 2 });
	});

	it("fullAudit：Base active dir 磁盘消失 → deleted(kind=2) tombstone（§7.5）", async () => {
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeVault([], [], new Map()),
				base: base({ a: dirEntry("550e8400-e29b-41d4-a716-446655440000") }),
				forceAudit: true,
			}),
		);
		expect(res.snapshot.entries["a"]).toEqual({ state: "deleted", kind: 2 });
	});

	it("fullAudit：Base file 磁盘消失 → deleted tombstone", async () => {
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeVault([], [], new Map()),
				base: base({ "a/x.md": { state: "active", content_hash: "h", size: "3" } }),
				forceAudit: true,
			}),
		);
		expect(res.snapshot.entries["a/x.md"]).toEqual({ state: "deleted" }); // kind 缺省即文件
	});
});

describe("applyDirty 目录事件", () => {
	it("TFolder dirty（无 Base 行）→ 物化 active dir", async () => {
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeVault([], [tdir("newdir")], new Map()),
				dirtyPaths: ["newdir"],
			}),
		);
		expect(res.snapshot.entries["newdir"]).toMatchObject({ state: "active", kind: 2 });
	});

	it("TFolder dirty（Base tombstone 重建同名空目录）→ 物化 active dir（统一规则，无复活循环）", async () => {
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeVault([], [tdir("a")], new Map()),
				base: base({ a: { state: "deleted", kind: 2 } }),
				dirtyPaths: ["a"],
			}),
		);
		expect(res.snapshot.entries["a"]).toMatchObject({ state: "active", kind: 2 });
	});

	it("目录 delete 事件（索引已无）→ deleted(kind=2)，保留 dir tombstone 语义", async () => {
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeVault([], [], new Map()),
				base: base({ a: dirEntry("550e8400-e29b-41d4-a716-446655440000") }),
				dirtyPaths: ["a"],
			}),
		);
		expect(res.snapshot.entries["a"]).toEqual({ state: "deleted", kind: 2 });
	});
});

describe("renameHints file_id 继承", () => {
	it("目录自身精确匹配 hint 继承 dir file_id", async () => {
		const d1 = "550e8400-e29b-41d4-a716-446655440010";
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeVault([], [tdir("b")], new Map()),
				base: base({ a: dirEntry(d1) }),
				renameHints: [["b", "a"]],
				forceAudit: true,
			}),
		);
		expect(res.snapshot.entries["b"].file_id).toBe(d1);
	});

	it("目录重命名的子文件经前缀展开继承 file_id（b/x.md ← a/x.md）", async () => {
		const f1 = "550e8400-e29b-41d4-a716-446655440020";
		const content = enc("abc");
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeVault([tf("b/x.md", "abc")], [tdir("b")], new Map([["b/x.md", content]])),
				base: base({
					a: dirEntry("550e8400-e29b-41d4-a716-446655440030"),
					"a/x.md": { state: "active", content_hash: await sha256Hex(content), size: "3", file_id: f1 },
				}),
				renameHints: [["b", "a"]],
				forceAudit: true,
			}),
		);
		const e = res.snapshot.entries;
		expect(e["b/x.md"].file_id).toBe(f1); // 前缀展开继承
		expect(e["a/x.md"].state).toBe("deleted"); // §7.5 旧路径 tombstone
	});
});

// Local Snapshot 目录物化（统一规则）与 renameHints 前缀展开测试。
// fake vault 以 TFile/TFolder 实例驱动（obsidian-stub 的空类 + Object.assign 赋 path/stat）。
import { describe, expect, it } from "vitest";
import { TFile, TFolder, type Vault } from "obsidian";
import { sha256Hex } from "../src/sync/content-hash";
import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import { createSyncFilter, defaultSelectiveSettings, type SelectiveSettings } from "../src/sync/selective";
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

/** 测试用过滤：默认关闭全部配置分类（fake vault 没有 adapter.list，配置扫描必须短路） */
function testFilter(over: {
	selective?: Partial<Omit<SelectiveSettings, "config">>;
	config?: Partial<SelectiveSettings["config"]>;
	configDir?: string;
	selfDir?: string;
	selfId?: string;
} = {}) {
	const defaults = defaultSelectiveSettings();
	const allConfigOff = {
		app: false, appearance: false, appearanceData: false, hotkey: false,
		corePlugin: false, corePluginData: false, communityPlugin: false, communityPluginData: false,
	};
	return createSyncFilter({
		selective: {
			...defaults,
			...over.selective,
			excludedFolders: over.selective?.excludedFolders ?? [],
			config: { ...allConfigOff, ...over.config },
		},
		configDir: over.configDir ?? ".obsidian",
		selfDir: over.selfDir ?? ".obsidian/plugins/pickpen",
		selfId: over.selfId ?? "pickpen",
	});
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
	filter?: ReturnType<typeof testFilter>;
}) {
	return {
		vault: over.vault,
		base: over.base ?? null,
		dirtyPaths: over.dirtyPaths ? new Set(over.dirtyPaths) : undefined,
		renameHints: over.renameHints ? new Map(over.renameHints) : undefined,
		forceAudit: over.forceAudit ?? false,
		filter: over.filter ?? testFilter(),
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

/** 带配置文件能力的 fake vault：索引之外的 .obsidian/** 走 adapter.list/stat/readBinary */
function fakeConfigVault(
	files: TFile[],
	dirs: TFolder[],
	contents: Map<string, Uint8Array>,
	config: {
		listing?: Record<string, { files: string[]; folders: string[] }>;
		stats?: Record<string, { mtime: number; size: number }>;
		contents?: Map<string, Uint8Array>;
	},
): Vault {
	const listing = config.listing ?? {};
	const stats = config.stats ?? {};
	const configContents = config.contents ?? new Map<string, Uint8Array>();
	return {
		getFiles: () => files,
		getAllLoadedFiles: () => [...dirs, ...files] as TFile[],
		getFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
		getAbstractFileByPath: (p: string) => [...dirs, ...files].find((f) => f.path === p) ?? null,
		adapter: {
			readBinary: async (p: string) => configContents.get(p) ?? contents.get(p) ?? new Uint8Array(0),
			list: async (p: string) => listing[p] ?? { files: [], folders: [] },
			stat: async (p: string) => stats[p] ?? null,
		},
	} as unknown as Vault;
}

describe("选择性同步：被排除路径不进 L、也不合成删除（既有缺陷回归）", () => {
	it("已同步文件被排除后：不得记为 deleted，也不得进 blocked", async () => {
		const content = enc("txt content");
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				// 磁盘上文件仍在（TFile 在索引里），但「其他类型文件」关闭 → 该路径本轮不参与同步
				vault: fakeVault([tf("a.txt", "txt content")], [], new Map([["a.txt", content]])),
				base: base({ "a.txt": { state: "active", content_hash: "old", size: "3", file_id: "550e8400-e29b-41d4-a716-446655440001" } }),
				forceAudit: true,
			}),
		);
		expect(res.snapshot.entries["a.txt"]).toBeUndefined(); // 既不 active 也不 deleted
		expect(res.blockedPaths).toEqual([]); // 用户主动排除，不是阻塞
	});

	it("排除文件夹内的已同步文件同样不合成删除", async () => {
		const content = enc("secret");
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeVault([tf("private/a.md", "secret")], [tdir("private")], new Map([["private/a.md", content]])),
				base: base({
					private: dirEntry("550e8400-e29b-41d4-a716-446655440002"),
					"private/a.md": { state: "active", content_hash: "old", size: "6", file_id: "550e8400-e29b-41d4-a716-446655440003" },
				}),
				forceAudit: true,
				filter: testFilter({ selective: { excludedFolders: ["private"] } }),
			}),
		);
		expect(res.snapshot.entries["private/a.md"]).toBeUndefined();
		expect(res.snapshot.entries["private"]).toBeUndefined();
		expect(res.blockedPaths).toEqual([]);
	});

	it("未排除的类型照常同步（对照组）", async () => {
		const content = enc("note");
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeVault([tf("a.md", "note")], [], new Map([["a.md", content]])),
				forceAudit: true,
			}),
		);
		expect(res.snapshot.entries["a.md"]).toMatchObject({ state: "active", content_hash: await sha256Hex(content) });
	});
});

describe("选择性同步：配置文件（配置目录不在 vault 索引里）", () => {
	const appJson = enc(`{"alwaysUpdateLinks":true}`);
	const mtime = 1_700_000_000_000;

	it("fullAudit 经 adapter 枚举纳入启用的配置分类", async () => {
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeConfigVault([], [], new Map(), {
					listing: {
						".obsidian": { files: [".obsidian/app.json", ".obsidian/workspace.json", ".obsidian/appearance.json"], folders: [] },
					},
					stats: {
						".obsidian/app.json": { mtime, size: appJson.byteLength },
						".obsidian/appearance.json": { mtime, size: 5 },
					},
					contents: new Map([["appJson", appJson], [".obsidian/app.json", appJson], [".obsidian/appearance.json", enc("{}")]]),
				}),
				forceAudit: true,
				filter: testFilter({ config: { app: true, appearance: false } }),
			}),
		);
		expect(res.snapshot.entries[".obsidian/app.json"]).toMatchObject({
			state: "active",
			content_hash: await sha256Hex(appJson),
			size: String(appJson.byteLength),
		});
		// appearance.json 分类未开、workspace.json 恒排除
		expect(res.snapshot.entries[".obsidian/appearance.json"]).toBeUndefined();
		expect(res.snapshot.entries[".obsidian/workspace.json"]).toBeUndefined();
		expect(res.blockedPaths).toEqual([]);
	});

	it("分类全部关闭时不触碰 adapter，配置目录一个条目都不进", async () => {
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeConfigVault([], [], new Map(), {
					listing: { ".obsidian": { files: [".obsidian/app.json"], folders: [] } },
					stats: { ".obsidian/app.json": { mtime, size: 5 } },
				}),
				forceAudit: true,
				filter: testFilter(), // config 全关
			}),
		);
		expect(res.snapshot.entries[".obsidian/app.json"]).toBeUndefined();
	});

	it("超限的配置文件跳过且不 blocked（可选能力不把状态钉在受阻）", async () => {
		const b = new LocalSnapshotBuilder();
		const res = await b.refresh(
			refreshCtx({
				vault: fakeConfigVault([], [], new Map(), {
					listing: { ".obsidian": { files: [".obsidian/app.json"], folders: [] } },
					stats: { ".obsidian/app.json": { mtime, size: 9_999 } },
				}),
				forceAudit: true,
				maxFileSizeBytes: 10,
				filter: testFilter({ config: { app: true } }),
			}),
		);
		expect(res.snapshot.entries[".obsidian/app.json"]).toBeUndefined();
		expect(res.blockedPaths).toEqual([]);
	});

	it("增量轮次：配置 dirty 路径经 adapter 判定（hash 更新 / 磁盘消失记删除）", async () => {
		const b = new LocalSnapshotBuilder();
		const cfgFilter = testFilter({ config: { app: true } });
		// 首轮：建立 baseline（配置文件存在）
		await b.refresh(
			refreshCtx({
				vault: fakeConfigVault([], [], new Map(), {
					listing: { ".obsidian": { files: [".obsidian/app.json"], folders: [] } },
					stats: { ".obsidian/app.json": { mtime, size: appJson.byteLength } },
					contents: new Map([[".obsidian/app.json", appJson]]),
				}),
				forceAudit: true,
				filter: cfgFilter,
			}),
		);
		// 内容变了：dirty 路径 → 重新哈希
		const changed = enc(`{"alwaysUpdateLinks":false}`);
		const res = await b.refresh(
			refreshCtx({
				vault: fakeConfigVault([], [], new Map(), {
					stats: { ".obsidian/app.json": { mtime: mtime + 1, size: changed.byteLength } },
					contents: new Map([[".obsidian/app.json", changed]]),
				}),
				dirtyPaths: [".obsidian/app.json"],
				filter: cfgFilter,
			}),
		);
		expect(res.snapshot.entries[".obsidian/app.json"]).toMatchObject({
			state: "active",
			content_hash: await sha256Hex(changed),
		});
		// 磁盘上没了：记删除（不因「索引里没有」而误判）
		const gone = await b.refresh(
			refreshCtx({
				vault: fakeConfigVault([], [], new Map(), {}),
				dirtyPaths: [".obsidian/app.json"],
				filter: cfgFilter,
			}),
		);
		expect(gone.snapshot.entries[".obsidian/app.json"]).toEqual({ state: "deleted" }); // kind 缺省即文件
	});
});

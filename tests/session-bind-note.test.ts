// 端到端回归（真实 ReconcileSession + LocalSnapshotBuilder + 假 vault/假服务端）：
// 「绑定仓库 → 新增笔记 → 同步」这条链路，以及一轮在本地扫描之前结束（未登录/未解锁/Head 失败）时
// dirty 不得被吞掉。
//
// 背景（线上反馈）：桌面端绑定移动端新建的仓库后新增笔记，点同步显示「已全部同步（无变化）」，
// 移动端一直看不到；关掉重开（启动 forceAudit）笔记才传上去。两个已复现的根因：
//   ① 扫描前结束的轮次（未登录/未解锁/Head 抖动）会吞掉已消费的 dirty —— 增量扫描只认 dirty 路径，
//      该路径再也不会被扫到，对账一直认为「本地 = Base」；
//   ② 绑定轮把远端配置写盘后，内存快照仍留写盘前的内容（配置目录没有 vault 事件），
//      对账据此产出「内容已不是磁盘那份」的 put，提交前复验必然失败——旧实现会静默结束整轮，
//      同轮新建的笔记跟着一起被吞。
import { describe, expect, it } from "vitest";
import { TFile, TFolder, type Vault } from "obsidian";

import { sha256Hex } from "../src/sync/content-hash";
import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import { buildTree } from "../src/sync/merkle";
import { ReconcileSession } from "../src/sync/session";
import type { Entry, Snapshot } from "../src/sync/types";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(u.byteLength);
	copy.set(u);
	return copy.buffer;
}

interface Server {
	entries: Record<string, Entry>;
	blobs: Map<string, Uint8Array>;
	revision: bigint;
	root: string;
}

interface Env {
	session: ReconcileSession;
	server: Server;
	failNextPollHead: { value: boolean };
	/** 前置检查（加密仓库解锁）开关；默认放行 */
	preflight: { allow: boolean };
	addLocalFile(path: string, content: string): void;
	addConfigFile(path: string, content: string): void;
}

async function makeEnv(remoteEntries: Record<string, Entry> = {}): Promise<Env> {
	// ---- 假磁盘 + 假 vault 索引（adapter 写盘会同步更新索引，等价 Obsidian 的文件监听） ----
	const disk = new Map<string, Uint8Array>();
	const files = new Map<string, TFile>();
	const dirs = new Set<string>();
	let clock = 1000;

	const touch = (path: string): void => {
		const content = disk.get(path);
		if (!content) return;
		files.set(
			path,
			Object.assign(new TFile(), { path, stat: { mtime: ++clock, size: content.byteLength } }) as TFile,
		);
	};

	const adapter = {
		readBinary: async (p: string) => {
			const b = disk.get(p);
			if (!b) throw new Error(`ENOENT ${p}`);
			return toArrayBuffer(b);
		},
		writeBinary: async (p: string, buf: ArrayBuffer) => {
			disk.set(p, new Uint8Array(buf.slice(0)));
			touch(p);
		},
		write: async (p: string, data: string) => {
			disk.set(p, enc(data));
			touch(p);
		},
		read: async (p: string) => {
			const b = disk.get(p);
			if (!b) throw new Error(`ENOENT ${p}`);
			return new TextDecoder().decode(b);
		},
		stat: async (p: string) => {
			const b = disk.get(p);
			if (!b) throw new Error(`ENOENT ${p}`);
			return { mtime: clock, size: b.byteLength };
		},
		exists: async (p: string) => disk.has(p),
		mkdir: async (p: string) => void dirs.add(p),
		rmdir: async (p: string) => void dirs.delete(p),
		remove: async (p: string) => {
			disk.delete(p);
			files.delete(p);
		},
		rename: async (from: string, to: string) => {
			const b = disk.get(from);
			if (b) {
				disk.set(to, b);
				disk.delete(from);
			}
			touch(to);
		},
		// 配置目录枚举：config 文件不在 vault 索引里，扫描只能走 adapter.list
		list: async (dir: string) => ({
			files: [...disk.keys()].filter((k) => dir === ".obsidian" && k.startsWith(".obsidian/") && !k.slice(11).includes("/")),
			folders: [],
		}),
	};

	/** 配置文件（配置目录内）：只落盘、不进 vault 索引——与宿主行为一致 */
	const addConfigFile = (path: string, content: string): void => {
		disk.set(path, enc(content));
	};

	const vault = {
		configDir: ".obsidian",
		adapter,
		getFiles: () => [...files.values()],
		getAllLoadedFiles: () => [...files.values()],
		getFileByPath: (p: string) => files.get(p) ?? null,
		getAbstractFileByPath: (p: string) => files.get(p) ?? (dirs.has(p) ? Object.assign(new TFolder(), { path: p }) : null),
	} as unknown as Vault;

	// ---- 假服务端（CAS + 目标 root 校验，语义对齐 CommitSnapshot） ----
	const recompute = async (entries: Record<string, Entry>): Promise<string> => (await buildTree(entries)).rootHash;
	const server: Server = {
		entries: { ...remoteEntries },
		blobs: new Map(),
		revision: Object.keys(remoteEntries).length > 0 ? 1n : 0n,
		root: await recompute(remoteEntries),
	};
	for (const e of Object.values(server.entries)) {
		if (e.content_hash) server.blobs.set(e.content_hash, enc("seeded"));
	}

	const baseStore = {
		base: null as Snapshot | null,
		getBase(): Snapshot | null {
			return this.base;
		},
		reset(): void {
			this.base = null;
		},
		async flush(): Promise<void> {},
		// 与真实 BaseStore.saveBase 同口径（base-only 字段一律按本轮实况重写）
		async saveBase(
			snapshot: Snapshot,
			opts: { unverified?: (path: string) => boolean; outOfScope?: (path: string) => boolean } = {},
		): Promise<void> {
			const entries: Record<string, Entry> = {};
			for (const [path, e] of Object.entries(snapshot.entries)) {
				const { local_mtime: _m, local_size: _s, out_of_scope: _o, ...rest } = e;
				if (opts.outOfScope ? opts.outOfScope(path) : e.out_of_scope) {
					entries[path] = { ...rest, out_of_scope: true };
					continue;
				}
				if (e.state !== "active" || opts.unverified?.(path)) {
					entries[path] = rest;
					continue;
				}
				let stat: { mtime: number; size: number } | null = null;
				try {
					stat = await adapter.stat(path);
				} catch {
					stat = null;
				}
				if (stat) entries[path] = { ...rest, local_mtime: String(stat.mtime), local_size: String(stat.size) };
				else entries[path] = rest;
			}
			this.base = { ...snapshot, entries };
		},
	};

	const pendingStore = {
		pending: null as unknown,
		getPending(): unknown {
			return this.pending;
		},
		async writePrepared(log: unknown): Promise<void> {
			this.pending = { ...(log as object), phase: "prepared", target_revision: null };
		},
		async markCommitted(rev: string): Promise<void> {
			this.pending = { ...(this.pending as object), phase: "committed", target_revision: rev };
		},
		async markApplying(): Promise<void> {
			this.pending = { ...(this.pending as object), phase: "applying" };
		},
		async clear(): Promise<void> {
			this.pending = null;
		},
	};

	const failNextPollHead = { value: false };
	const head = () => ({
		vaultId: "42",
		revision: server.revision,
		rootHash: server.root,
		unchanged: false,
		syncIntervalMs: 0n,
		maxFileSizeBytes: 30n * 1024n * 1024n,
		localDebounceMs: 0n,
		encrypted: false,
		keyVersion: 0n,
	});

	const remote = {
		async getHead() {
			return head();
		},
		async pollHead(knownRevision: bigint, knownRootHash: string) {
			if (failNextPollHead.value) {
				failNextPollHead.value = false;
				throw new Error("网络抖动（模拟 Head 请求失败）");
			}
			return { ...head(), unchanged: knownRevision === server.revision && knownRootHash === server.root };
		},
		async getManifest(rev: bigint, root: string) {
			if (rev !== server.revision || root !== server.root) throw new Error("12015 快照已变化");
			return { revision: server.revision, rootHash: server.root, vaultId: "42", entries: { ...server.entries } };
		},
		async hasBlobs(hashes: string[]) {
			return new Set(hashes.filter((h) => server.blobs.has(h)));
		},
		async putBlob(hash: string, content: Uint8Array) {
			server.blobs.set(hash, content);
		},
		async getBlob(hash: string) {
			const b = server.blobs.get(hash);
			if (!b) throw new Error(`12021 内容不存在 ${hash}`);
			return b;
		},
		async commitSnapshot(args: {
			expectedRevision: bigint;
			expectedRootHash: string;
			targetRootHash: string;
			puts: Array<{ path: string; content_hash: string; size: string; file_id: string; kind?: number }>;
			deletes: string[];
		}) {
			if (args.expectedRevision !== server.revision || args.expectedRootHash !== server.root) {
				if (server.root === args.targetRootHash) {
					return { revision: server.revision, rootHash: server.root, changed: false };
				}
				return null; // 12015
			}
			const next: Record<string, Entry> = { ...server.entries };
			for (const p of args.puts) {
				next[p.path] = {
					state: "active",
					content_hash: p.content_hash,
					size: p.size,
					kind: p.kind,
					file_id: p.file_id,
				};
			}
			for (const d of args.deletes) next[d] = { state: "deleted", kind: next[d]?.kind };
			const newRoot = await recompute(next);
			if (newRoot !== args.targetRootHash) {
				throw new Error(`12004 目标 root 不符：声明 ${args.targetRootHash}，重算 ${newRoot}`);
			}
			if (newRoot === server.root) return { revision: server.revision, rootHash: server.root, changed: false };
			server.entries = next;
			server.revision += 1n;
			server.root = newRoot;
			return { revision: server.revision, rootHash: server.root, changed: true };
		},
	};

	const preflight = { allow: true };
	const session = new ReconcileSession({
		app: {
			vault,
			workspace: { getLeavesOfType: () => [] },
			fileManager: {
				trashFile: async (f: TFile) => {
					disk.delete(f.path);
					files.delete(f.path);
				},
			},
		} as never,
		getSettings: () => ({ accessToken: "t", vaultId: "42", deviceId: "dev-1" }) as never,
		baseStore: baseStore as never,
		pendingStore: pendingStore as never,
		localBuilder: new LocalSnapshotBuilder(),
		remote: remote as never,
		preflight: async () => preflight.allow,
		pluginDir: ".obsidian/plugins/pickpen",
		pluginId: "pickpen",
		caseInsensitive: false,
		onStatus: () => {},
	} as never);

	return {
		session,
		server,
		failNextPollHead,
		preflight,
		addLocalFile(path: string, content: string) {
			disk.set(path, enc(content));
			touch(path);
		},
		addConfigFile,
	};
}

async function idle(session: ReconcileSession): Promise<void> {
	for (let i = 0; i < 200 && session.isRunning(); i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** 空远端（移动端刚建好的仓库）：绑定 → 新增笔记 → 手动同步，期望笔记上传 */
async function bindThenCreateNote(env: Env): Promise<void> {
	env.session.requestRun({ forceAudit: true, interactive: true });
	await idle(env.session);
	env.addLocalFile("笔记.md", "hello");
	env.session.addDirty("笔记.md");
}

describe("绑定仓库后新增笔记", () => {
	it("绑定（空仓库）→ 新增笔记 → 同步应上传", async () => {
		const env = await makeEnv();
		await bindThenCreateNote(env);
		await env.session.requestManualRun();
		expect(env.server.entries["笔记.md"]).toBeDefined();
	});

	it("远端已有文件：绑定 → 新增笔记 → 同步应上传", async () => {
		const remoteContent = enc("from mobile");
		const hash = await sha256Hex(remoteContent);
		const env = await makeEnv({
			"mobile.md": {
				state: "active",
				content_hash: hash,
				size: String(remoteContent.byteLength),
				kind: 1,
				file_id: "550e8400-e29b-41d4-a716-446655440000",
			},
		});
		env.server.blobs.set(hash, remoteContent); // 远端真实内容（下载会校验 hash）
		await bindThenCreateNote(env);
		await env.session.requestManualRun();
		expect(env.server.entries["笔记.md"]).toBeDefined();
	});

	// 回归：dirty 在轮次一开始就被消费，而增量扫描只认 dirty 路径。若这一轮在扫描本地之前
	// 就结束（Head 请求抖动失败），把 dirty 丢掉等于这条路径永远不再被扫到——点同步只会得到
	// 「已全部同步（无变化）」，只有重启（forceAudit）才能找回。
	it("扫描前失败的一轮不吞 dirty：网络恢复后同步仍能补传笔记", async () => {
		const env = await makeEnv();
		await bindThenCreateNote(env);

		env.failNextPollHead.value = true; // 笔记那轮：Head 请求抖动一次
		env.session.requestRun();
		await idle(env.session);
		expect(env.server.entries["笔记.md"]).toBeUndefined(); // 本轮确实没传上去

		await env.session.requestManualRun(); // 网络已恢复，用户点「立即同步」
		expect(env.server.entries["笔记.md"]).toBeDefined();
	});

	it("未解锁（前置检查未过）期间结束的轮次不吞 dirty：解锁后同步补传", async () => {
		const env = await makeEnv();
		await bindThenCreateNote(env);

		env.preflight.allow = false; // 加密仓库尚未解锁：本轮不跑
		env.session.requestRun();
		await idle(env.session);
		expect(env.server.entries["笔记.md"]).toBeUndefined();

		env.preflight.allow = true; // 用户输入密码解锁 → 手动同步
		await env.session.requestManualRun();
		expect(env.server.entries["笔记.md"]).toBeDefined();
	});

	it("异常失败的一轮不吞 dirty：forceAudit 前手动同步即可补传", async () => {
		const env = await makeEnv();
		await bindThenCreateNote(env);

		// 连续两次 Head 失败（第二次覆盖「失败后再点同步」的场景）
		env.failNextPollHead.value = true;
		await env.session.requestManualRun();
		expect(env.server.entries["笔记.md"]).toBeUndefined();

		await env.session.requestManualRun();
		expect(env.server.entries["笔记.md"]).toBeDefined();
	});

	// 回归：绑定轮会把远端配置写盘（配置目录没有 vault 事件），内存快照若不跟着更新，
	// 每轮对账都会带一条内容已过时的配置 put，提交前复验失败把整轮（含笔记）一起吞掉。
	it("绑定轮写盘配置文件后：新增笔记仍能同步（快照不得留写盘前内容）", async () => {
		const remoteConfig = enc("remote-config-666");
		const hash = await sha256Hex(remoteConfig);
		const env = await makeEnv({
			".obsidian/core-plugins.json": {
				state: "active",
				content_hash: hash,
				size: String(remoteConfig.byteLength),
				kind: 1,
				file_id: "550e8400-e29b-41d4-a716-446655440010",
			},
		});
		env.server.blobs.set(hash, remoteConfig);
		// 本地（桌面端）已有一份不同的同名配置 → 绑定即产生配置冲突 + 远端版本落盘
		env.addConfigFile(".obsidian/core-plugins.json", "local-config-644");

		await bindThenCreateNote(env);
		await env.session.requestManualRun();
		expect(env.server.entries["笔记.md"]).toBeDefined();
	});

	// 回归：提交前复验发现「内容已不是计划那份」时，必须标脏该路径并自愈，
	// 不能静默结束整轮——否则同轮其它文件（如新建笔记）会一起被吞。
	it("复验发现内容不符：不静默吞掉整轮，自动重排后笔记仍同步", async () => {
		const env = await makeEnv();
		await bindThenCreateNote(env);

		// 让第一次复验失败一次（等价于「提交前本地内容已不是计划那份」）
		const s = env.session as unknown as { unchanged: (c: ArrayBuffer, h: string) => Promise<boolean> };
		const orig = s.unchanged.bind(env.session);
		let tripped = false;
		s.unchanged = async (c, h) => {
			if (!tripped) {
				tripped = true;
				return false;
			}
			return orig(c, h);
		};

		await env.session.requestManualRun();
		expect(tripped).toBe(true);
		// 修复前：本轮静默结束，笔记永远传不上去；修复后：标脏 + 自动重排，笔记最终上传
		expect(env.server.entries["笔记.md"]).toBeDefined();
	});
});

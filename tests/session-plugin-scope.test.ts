// 复现 + 回归（真实 ReconcileSession + LocalSnapshotBuilder + BaseStore + 假 vault/假服务端）：
// 「设备 A 打开『已安装的第三方插件』把插件目录同步上云 → 设备 B 在该开关关闭的状态下同步过一轮
//  → 用户在设备 B 打开该开关并点同步」这条链路。
//
// 期望：设备 B 从云端把插件下载下来（远端胜），本地那份不同的内容留成不参与同步的冲突副本。
// 缺陷（本用例复现）：设备 B 反而把本地那份传上去，覆盖了云端的插件——设备 A 下次同步跟着被覆盖。
//
// 根因：被选择性同步排除的路径虽然不进本地快照，写 Base 时却把远端状态（远端回声）当成
// 「双方已达成一致」落盘。开关一打开，本地内容与这份回声不同 → planner 按「仅 Local 变」裁决 → 上传。
// 本地没有该文件时更糟：Base 有、磁盘没有 → Local 记为删除 → 「仅 Local 变（删除）」→ 删掉远端那份。
import { describe, expect, it } from "vitest";
import { TFile, TFolder, type Vault } from "obsidian";

import { BaseStore } from "../src/sync/base-store";
import { sha256Hex } from "../src/sync/content-hash";
import { LocalSnapshotBuilder } from "../src/sync/local-snapshot";
import { buildTree } from "../src/sync/merkle";
import { defaultSelectiveSettings } from "../src/sync/selective";
import { ReconcileSession } from "../src/sync/session";
import type { Entry } from "../src/sync/types";

const PLUGIN_PATH = ".obsidian/plugins/dataview/main.js";
const PLUGIN_DIR = ".obsidian/plugins/pickpen";
const FILE_ID = "550e8400-e29b-41d4-a716-446655440000";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(u.byteLength);
	copy.set(u);
	return copy.buffer;
}

interface Env {
	session: ReconcileSession;
	baseStore: BaseStore;
	/** 远端当前状态（put/delete 生效后的结果）；每次读取都取最新（提交会整体换掉这份表） */
	readonly remoteEntries: Record<string, Entry>;
	/** 本设备的选择性同步设置（测试直接改它模拟用户拨开关） */
	settings: { selective: ReturnType<typeof defaultSelectiveSettings> };
	/** 把文件写进配置目录（配置目录不在 vault 索引里，只落盘） */
	writePluginFile(path: string, content: string): void;
	readPluginFile(path: string): string;
	/** 配置目录（含插件目录）下的全部路径 */
	listPluginFiles(): string[];
	/** 往假服务端塞一份内容（下载会校验 hash） */
	seedBlob(hash: string, content: string): void;
}

async function makeEnv(remoteEntries: Record<string, Entry> = {}): Promise<Env> {
	// ---- 假磁盘 + 假 vault 索引 ----
	const disk = new Map<string, Uint8Array>();
	const mtimes = new Map<string, number>();
	const files = new Map<string, TFile>();
	const dirs = new Set<string>();
	let clock = 1000;

	const writeDisk = (path: string, content: Uint8Array): void => {
		disk.set(path, content);
		mtimes.set(path, ++clock);
	};
	const touchIndex = (path: string): void => {
		const content = disk.get(path);
		if (!content) return;
		files.set(
			path,
			Object.assign(new TFile(), { path, stat: { mtime: mtimes.get(path)!, size: content.byteLength } }) as TFile,
		);
	};

	const adapter = {
		readBinary: async (p: string) => {
			const b = disk.get(p);
			if (!b) throw new Error(`ENOENT ${p}`);
			return toArrayBuffer(b);
		},
		writeBinary: async (p: string, buf: ArrayBuffer) => {
			writeDisk(p, new Uint8Array(buf.slice(0)));
			touchIndex(p);
		},
		write: async (p: string, data: string) => {
			writeDisk(p, enc(data));
			touchIndex(p);
		},
		read: async (p: string) => {
			const b = disk.get(p);
			if (!b) throw new Error(`ENOENT ${p}`);
			return dec(b);
		},
		stat: async (p: string) => {
			const b = disk.get(p);
			if (!b) throw new Error(`ENOENT ${p}`);
			return { mtime: mtimes.get(p)!, size: b.byteLength };
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
				mtimes.set(to, ++clock);
			}
			touchIndex(to);
		},
		// 配置目录枚举（scanConfigFiles 走 list 下潜）：按真实目录语义由磁盘内容推导
		list: async (dir: string) => {
			const prefix = `${dir}/`;
			const listedFiles: string[] = [];
			const folders = new Set<string>();
			for (const key of disk.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				const slash = rest.indexOf("/");
				if (slash < 0) listedFiles.push(key);
				else folders.add(prefix + rest.slice(0, slash));
			}
			return { files: listedFiles, folders: [...folders] };
		},
	};

	const vault = {
		configDir: ".obsidian",
		adapter,
		getFiles: () => [...files.values()],
		getAllLoadedFiles: () => [...files.values()],
		getFileByPath: (p: string) => files.get(p) ?? null,
		getAbstractFileByPath: (p: string) =>
			files.get(p) ?? (dirs.has(p) ? Object.assign(new TFolder(), { path: p }) : null),
	} as unknown as Vault;

	// ---- 假服务端（CAS + 目标 root 校验，语义对齐 CommitSnapshot） ----
	const recompute = async (entries: Record<string, Entry>): Promise<string> => (await buildTree(entries)).rootHash;
	const server = {
		entries: { ...remoteEntries } as Record<string, Entry>,
		blobs: new Map<string, Uint8Array>(),
		revision: 0n,
		root: "",
	};
	server.root = await recompute(server.entries);
	server.revision = Object.keys(server.entries).length > 0 ? 1n : 0n;

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
				if (server.root === args.targetRootHash) return { revision: server.revision, rootHash: server.root, changed: false };
				return null; // 12015
			}
			const next: Record<string, Entry> = { ...server.entries };
			for (const p of args.puts) {
				next[p.path] = { state: "active", content_hash: p.content_hash, size: p.size, kind: p.kind, file_id: p.file_id };
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

	const settings = {
		selective: defaultSelectiveSettings(),
	};
	const app = {
		vault,
		workspace: { getLeavesOfType: () => [] },
		fileManager: {
			trashFile: async (f: TFile) => {
				disk.delete(f.path);
				files.delete(f.path);
			},
		},
	};
	// 真实 BaseStore：落盘口径（local_* 快路径字段、原子写）与线上完全一致
	const baseStore = new BaseStore(
		{ app, manifest: { dir: PLUGIN_DIR } } as never,
		"dev-1",
	);

	const session = new ReconcileSession({
		app: app as never,
		getSettings: () =>
			({ accessToken: "t", vaultId: "42", deviceId: "dev-1", selective: settings.selective }) as never,
		baseStore,
		pendingStore: pendingStore as never,
		localBuilder: new LocalSnapshotBuilder(),
		remote: remote as never,
		preflight: async () => true,
		pluginDir: PLUGIN_DIR,
		pluginId: "pickpen",
		caseInsensitive: false,
		onStatus: () => {},
	} as never);

	return {
		session,
		baseStore,
		get remoteEntries() {
			return server.entries;
		},
		settings,
		writePluginFile(path, content) {
			writeDisk(path, enc(content));
		},
		readPluginFile(path) {
			const b = disk.get(path);
			if (!b) throw new Error(`ENOENT ${path}`);
			return dec(b);
		},
		listPluginFiles() {
			return [...disk.keys()].filter((k) => k.startsWith(".obsidian/plugins/"));
		},
		seedBlob(hash, content) {
			server.blobs.set(hash, enc(content));
		},
	};
}

async function idle(session: ReconcileSession): Promise<void> {
	for (let i = 0; i < 200 && session.isRunning(); i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** 设备 A：插件目录已同步上云 */
async function remotePluginEnv(content = "remote-plugin-v1"): Promise<Env> {
	const bytes = enc(content);
	const hash = await sha256Hex(bytes);
	const env = await makeEnv({
		[PLUGIN_PATH]: {
			state: "active",
			content_hash: hash,
			size: String(bytes.byteLength),
			kind: 1,
			file_id: FILE_ID,
		},
	});
	env.seedBlob(hash, content);
	return env;
}

/** 设备 B：开关关闭状态下同步过一轮（Base 里落下插件路径的远端回声） */
async function syncWithPluginScopeOff(env: Env): Promise<void> {
	await env.session.requestManualRun();
}

/** 用户点「立即同步」（不强制全量审计，与 Ribbon 一致） */
async function syncNow(env: Env): Promise<void> {
	await env.session.requestManualRun();
}

/** 一轮强制全量审计的同步（配置目录不在 vault 索引里，改动要靠 sweep/审计才能被看到） */
async function syncAudit(env: Env): Promise<void> {
	env.session.requestRun({ forceAudit: true });
	await idle(env.session);
}

/** 用户拨开关：与设置页一致——落盘设置 + 强制全量审计 */
async function togglePluginScope(env: Env, value: boolean): Promise<void> {
	env.settings.selective.config.communityPluginData = value;
	await syncAudit(env);
}

describe("『已安装的第三方插件』由关到开：远端胜，不得上传覆盖", () => {
	it("本地有一份不同内容的插件：应下载远端，而不是上传本地覆盖远端", async () => {
		const env = await remotePluginEnv();
		env.writePluginFile(PLUGIN_PATH, "local-plugin-v9"); // 本设备自己的那份（与云端不同）
		await syncWithPluginScopeOff(env);

		// 开关关闭的这一轮：插件路径不进本地快照，但远端状态被当成 Base 落盘
		const base = env.baseStore.getBase()!;
		expect(base.entries[PLUGIN_PATH]).toBeDefined();

		await togglePluginScope(env, true); // 用户打开「已安装的第三方插件」

		// 远端仍是设备 A 那份：本地内容没有被当成「仅本地修改」传上去
		expect(env.remoteEntries[PLUGIN_PATH].content_hash).toBe(await sha256Hex(enc("remote-plugin-v1")));
		// 本地已被远端内容覆盖（下载），本地那份留在不参与同步的冲突副本里
		expect(env.readPluginFile(PLUGIN_PATH)).toBe("remote-plugin-v1");
		const copies = env.listPluginFiles().filter((p) => p.includes("(conflict "));
		expect(copies).toHaveLength(1);
		expect(env.readPluginFile(copies[0])).toBe("local-plugin-v9");
		// 冲突副本不上传（配置目录内的副本永远无人处理，只会变成孤儿）
		expect(env.remoteEntries[copies[0]]).toBeUndefined();
	});

	it("本设备没有这个插件：应下载，而不是把远端那份删掉", async () => {
		const env = await remotePluginEnv();
		await syncWithPluginScopeOff(env);
		expect(env.baseStore.getBase()!.entries[PLUGIN_PATH]).toBeDefined();

		await togglePluginScope(env, true);

		expect(env.remoteEntries[PLUGIN_PATH].state).toBe("active"); // 没有被删
		expect(env.readPluginFile(PLUGIN_PATH)).toBe("remote-plugin-v1"); // 已下载到本地
	});

	it("开关打开时本地内容恰好与远端一致：标记必须归一，此后本地修改照常上传", async () => {
		const env = await remotePluginEnv();
		env.writePluginFile(PLUGIN_PATH, "remote-plugin-v1"); // 本地那份与远端完全相同 → 本轮无工作
		await syncWithPluginScopeOff(env);

		await togglePluginScope(env, true);
		// 无工作轮也要落一次 Base 把标记清掉：留着的话这条路径此后一直被当 Bootstrap，
		// 用户的本地修改只会生成冲突副本、永远传不上去
		expect(env.baseStore.getBase()!.entries[PLUGIN_PATH].out_of_scope).toBeUndefined();

		env.writePluginFile(PLUGIN_PATH, "local-edit-v2");
		await syncAudit(env);
		expect(env.remoteEntries[PLUGIN_PATH].content_hash).toBe(await sha256Hex(enc("local-edit-v2")));
		expect(env.listPluginFiles().filter((p) => p.includes("(conflict "))).toHaveLength(0);
	});
});

// Merkle Tree 规范实现（spec §7）：真实路径逻辑 Trie + 逐字节一致的二进制编码。
// 编码为端间公共契约：实现改动须与 tests/fixtures/merkle 测试向量逐字节一致。

import { sha256Hex } from "./content-hash";
import { nfcPath } from "./path";

export const STATE_ACTIVE = "active";
export const STATE_DELETED = "deleted";

// 条目类型（int 枚举，1=file、2=dir；缺省按 file 兼容旧数据）
export const KIND_FILE = 1;
export const KIND_DIR = 2;

export interface Entry {
	state: "active" | "deleted";
	content_hash?: string;
	size?: string; // 十进制字符串（spec：int64 在 JSON 中一律十进制字符串）
	kind?: number; // KIND_FILE | KIND_DIR，缺省按 file
	file_id?: string; // 仅传输层稳定身份（rename 不变），不参与 hash
}

/** 实际类型（未设置按 file） */
export function effectiveKind(e: Entry): number {
	return e.kind === KIND_DIR ? KIND_DIR : KIND_FILE;
}

const textEncoder = new TextEncoder();

/** LEB128 无符号 varint 编码（size < 2^53 安全，spec §7.3 长度前缀统一使用）。
 * 用 % / 128 而非位运算（JS 位运算截断到 int32，2^32 以上出错） */
export function encodeVarint(n: number): Uint8Array {
	const out: number[] = [];
	let v = Math.trunc(n);
	while (v >= 0x80) {
		out.push((v % 128) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v % 128);
	return new Uint8Array(out);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

export function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

/** 字节数组按字节序比较（等于 Go 的 bytes.Compare） */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}

/**
 * 叶子 hash（spec §7.3）：
 *   active_file = SHA256(0x00 || varint(path) || path || 0x01 || hash32 || uint64_be(size))
 *   active_dir  = SHA256(0x00 || varint(path) || path || 0x03)
 *   deleted     = SHA256(0x00 || varint(path) || path || 0x02)
 * 不含 mtime、updated_at、device_id、revision、file_id、kind 的其余语义。
 * file/dir tombstone 编码相同。返回 64 位 hex。
 */
export async function leafHashHex(path: string, e: Entry): Promise<string> {
	const np = nfcPath(path);
	if (np === null) throw new Error(`invalid protocol path: ${path}`);
	const pathBytes = textEncoder.encode(np);
	const parts: Uint8Array[] = [new Uint8Array([0x00]), encodeVarint(pathBytes.length), pathBytes];
	if (e.state === STATE_ACTIVE) {
		if (effectiveKind(e) === KIND_DIR) {
			// 防御编码歧义：dir 不得携带内容引用
			if (e.content_hash || e.size) throw new Error("dir entry cannot carry content");
			parts.push(new Uint8Array([0x03]));
		} else {
			if (!e.content_hash || e.content_hash.length !== 64) throw new Error("invalid content_hash");
			const sz = new Uint8Array(8);
			new DataView(sz.buffer).setBigUint64(0, BigInt(e.size ?? "0"), false);
			parts.push(new Uint8Array([0x01]), hexToBytes(e.content_hash), sz);
		}
	} else if (e.state === STATE_DELETED) {
		parts.push(new Uint8Array([0x02]));
	} else {
		throw new Error(`invalid state: ${e.state}`);
	}
	return sha256Hex(concatBytes(...parts));
}

export interface DirChild {
	name: string; // NFC 规范化后的子名
	hash: Uint8Array;
}

/**
 * 目录/Trie 节点 hash（spec §7.4）：
 *   SHA256(0x01 || self_flag || [self_hash] || varint(child_count) ||
 *          for each child: varint(name) || name || child_hash)
 * self 只能是 deleted entry 或 active dir entry（active 文件节点不得有 children，由 buildTree 保证）。
 * children 必须已按 name 的 UTF-8 原始字节序排序，由调用方保证。
 */
export async function directoryHashHex(
	self: Entry | undefined,
	selfPath: string,
	children: DirChild[],
): Promise<string> {
	const parts: Uint8Array[] = [new Uint8Array([0x01])];
	if (self) {
		parts.push(new Uint8Array([0x01]), hexToBytes(await leafHashHex(selfPath, self)));
	} else {
		parts.push(new Uint8Array([0x00]));
	}
	parts.push(encodeVarint(children.length));
	for (const c of children) {
		const nameBytes = textEncoder.encode(c.name);
		parts.push(encodeVarint(nameBytes.length), nameBytes, c.hash);
	}
	return sha256Hex(concatBytes(...parts));
}

/** root hash（spec §7.4）：SHA256(0x02 || uint32_be(schema_version) || root_directory_hash) */
export async function rootHashHex(dirHash: Uint8Array, schemaVersion: number): Promise<string> {
	const v = new Uint8Array(4);
	new DataView(v.buffer).setUint32(0, schemaVersion, false);
	return sha256Hex(concatBytes(new Uint8Array([0x02]), v, dirHash));
}

/** 子名按 UTF-8 原始字节序排序（不能 localeCompare/码点序，spec §7.4） */
function sortNamesUtf8(names: string[]): string[] {
	return names
		.map((n) => ({ n, b: textEncoder.encode(n) }))
		.sort((a, b) => compareBytes(a.b, b.b))
		.map((x) => x.n);
}

export interface TreeNode {
	path: string; // 从 root 到本节点的相对路径（root 为 ""）
	entry?: Entry;
	children: Map<string, TreeNode>;
	hash?: Uint8Array; // hashNode 后填充
}

export const SCHEMA_VERSION = 2;

/** 构建 Trie 并自底向上计算全部节点 hash；entries 的 key 必须是协议路径（构建时仍校验一次） */
export function buildTree(entries: Record<string, Entry>): { root: TreeNode; rootHash: Promise<string> } {
	const root: TreeNode = { path: "", children: new Map() };
	for (const [path, e] of Object.entries(entries)) {
		const np = nfcPath(path);
		if (np === null) throw new Error(`invalid protocol path: ${path}`);
		insertNode(root, np, e);
	}
	const rootHash = hashNode(root, root, SCHEMA_VERSION).then((dirHash) =>
		rootHashHex(dirHash, SCHEMA_VERSION),
	);
	return { root, rootHash };
}

/** 逐级插入；active 文件节点不得拥有 children、不得重复插入同一路径（active dir 可拥有 children） */
function insertNode(root: TreeNode, path: string, e: Entry): void {
	let cur = root;
	const segs = path.split("/");
	for (const seg of segs) {
		let child = cur.children.get(seg);
		if (!child) {
			child = { path: cur.path === "" ? seg : `${cur.path}/${seg}`, children: new Map() };
			cur.children.set(seg, child);
		}
		if (child.entry && child.entry.state === STATE_ACTIVE && effectiveKind(child.entry) === KIND_FILE) {
			throw new Error("active entry cannot have children");
		}
		cur = child;
	}
	if (cur.entry) throw new Error("duplicate path after normalization");
	cur.entry = e;
	if (e.state === STATE_ACTIVE && effectiveKind(e) === KIND_FILE && cur.children.size > 0) {
		throw new Error("active entry cannot have children");
	}
}

/**
 * 自底向上计算节点 hash。叶子（无 children 有 entry）= LeafHash；
 * 目录（有 children，或空树根）= DirectoryHash。返回 hash 并回填 node.hash。
 */
async function hashNode(node: TreeNode, root: TreeNode, schemaVersion: number): Promise<Uint8Array> {
	if (node.entry && node.entry.state === STATE_ACTIVE && effectiveKind(node.entry) === KIND_FILE && node.children.size > 0) {
		throw new Error("active entry cannot have children");
	}
	if (node.children.size === 0 && node.entry) {
		const h = hexToBytes(await leafHashHex(node.path, node.entry));
		node.hash = h;
		return h;
	}
	const children: DirChild[] = [];
	for (const name of sortNamesUtf8([...node.children.keys()])) {
		const child = node.children.get(name)!;
		children.push({ name, hash: await hashNode(child, root, schemaVersion) });
	}
	const h = hexToBytes(await directoryHashHex(node.entry, node.path, children));
	node.hash = h;
	return h;
}

/** 按节点 hash 剪枝收集两棵树的差异路径（spec §8.1 的 diff(B, L)/diff(B, R)） */
export function diffPaths(a: TreeNode, b: TreeNode): string[] {
	const out: string[] = [];
	const walk = (x: TreeNode | undefined, y: TreeNode | undefined): void => {
		if (!x || !y) {
			if (x) out.push(...collectPaths(x));
			if (y) out.push(...collectPaths(y));
			return;
		}
		if (x.hash && y.hash && compareBytes(x.hash, y.hash) === 0) return; // 子树相同，剪枝
		if (x.children.size === 0 || y.children.size === 0) {
			if (x.children.size === 0 && y.children.size === 0) {
				if (x.path !== "") out.push(x.path);
				return;
			}
			out.push(...collectPaths(x), ...collectPaths(y));
			return;
		}
		const names = new Set([...x.children.keys(), ...y.children.keys()]);
		for (const name of names) walk(x.children.get(name), y.children.get(name));
	};
	walk(a, b);
	return out;
}

function collectPaths(node: TreeNode): string[] {
	const out: string[] = [];
	const walk = (n: TreeNode): void => {
		if (n.entry) out.push(n.path);
		for (const c of n.children.values()) walk(c);
	};
	walk(node);
	return out;
}

/** 空 Manifest 对应的确定性 root hash（创建空 Vault 时显式写入该值） */
export async function emptyRootHashHex(): Promise<string> {
	const root: TreeNode = { path: "", children: new Map() };
	const dirHash = await hashNode(root, root, SCHEMA_VERSION);
	return rootHashHex(dirHash, SCHEMA_VERSION);
}

// 路径编码边界层：同步内核仍按明文逻辑路径工作，只在「算 root / 提交 / 拉 Manifest」三处
// 与远端 token 表示互转。所有函数在仓库未启用路径加密时原样返回，保证 v1 行为逐字节不变。
//
// 不变量：
//   - Base / pending / planner 里的 path 永远是明文；
//   - 所有 root（localRoot / base_root_hash / target_root_hash / head.rootHash）都是 token 口径，
//     v2 叶子还包含 enc_path；
//   - 解出的明文路径必须用 token(明文) 与远端 key 严格比对，失败绝不当文件名写盘。

import { PathDecodeError, type PathCrypto } from "../crypto/path-crypto";
import { vaultKeys } from "../crypto/vault-key-store";
import { buildTree } from "./merkle";
import type { Entry, PutMutation } from "./types";

export interface DecodedManifest {
	/** 明文路径 keyed entries（enc_path 已剥离，可直接交给 planner/Base） */
	entries: Record<string, Entry>;
	/** enc_path 与本地确定性值不一致、但 token 匹配本地已知路径的条目（可强制 put 修复） */
	repairs: string[];
}

/** 路径加密模式常量（与协议 path_encryption_version 同值） */
export const PATH_MODE_PLAIN = 0;
export const PATH_MODE_ENCRYPTED = 1;

function enabled(mode: number): boolean {
	return mode === PATH_MODE_ENCRYPTED;
}

async function cipher(): Promise<PathCrypto> {
	// 以调用方传入的 mode 为准：迁移时仓库还是 v1，但目标 root 已需要 v2 编码；
	// pathCryptoUnlocked 只要求「已内容加密 + 已解锁」，不会因本机尚未收到 v2 状态而误拒。
	return vaultKeys.pathCryptoUnlocked();
}

/** 把本地/Base 的明文路径灌入 token 反向索引（manifest 解码时优先命中，避免逐条 AES） */
export async function indexPaths(paths: Iterable<string>, mode: number): Promise<void> {
	if (!enabled(mode)) return;
	await (await cipher()).indexPaths(paths);
}

/** 计算一批明文 entries 的远端 root（v1 原样；v2 先编码为 token+enc_path） */
export async function treeRoot(entries: Record<string, Entry>, mode: number): Promise<string> {
	if (!enabled(mode)) return buildTree(entries).rootHash;
	const c = await cipher();
	const encoded: Record<string, Entry> = {};
	for (const [path, e] of Object.entries(entries)) {
		const { key, encPath } = await c.encode(path);
		encoded[key] = { ...e, enc_path: encPath };
	}
	return buildTree(encoded, true).rootHash;
}

/**
 * 远端 Manifest entries（token keyed）→ 明文 entries。
 * - 已知 token（本地/Base 索引）：用本地确定的 enc_path 比对，不一致只标记 repair，不中断；
 * - 未知 token：解密 enc_path 并校验 token；
 * - enc_path 缺失/损坏且无法对应到本地路径：抛 PathDecodeError（调用方暂停本轮）。
 */
export async function decodeManifestEntries(
	raw: Record<string, Entry>,
	mode: number,
): Promise<DecodedManifest> {
	if (!enabled(mode)) {
		// 路径是用户可控字符串：必须用无原型对象，否则名为 constructor/toString 的条目
		// 会被 Object.prototype 误判为重复，名为 __proto__ 的条目会被原型 setter 静默吞掉。
		const entries = Object.create(null) as Record<string, Entry>;
		for (const [path, e] of Object.entries(raw)) {
			const { enc_path: _ignore, ...rest } = e;
			entries[path] = rest;
		}
		return { entries, repairs: [] };
	}
	const c = await cipher();
	const entries = Object.create(null) as Record<string, Entry>;
	const repairs = new Set<string>();
	for (const [remoteKey, rawEntry] of Object.entries(raw)) {
		const encPath = rawEntry.enc_path;
		const known = c.lookup(remoteKey);
		if (!encPath && known === undefined) {
			throw new PathDecodeError(`路径条目缺少 enc_path：${remoteKey}`);
		}
		let path: string;
		if (known !== undefined) {
			// 本地/Base 已知该 token：用确定性密文比对；缺失/不一致只标记 repair，不中断
			const local = await c.encode(known);
			if (local.encPath !== encPath) repairs.add(known);
			path = known;
		} else {
			path = await c.openEntry(remoteKey, encPath!);
		}
		if (Object.hasOwn(entries, path)) throw new PathDecodeError(`manifest 解出重复路径：${path}`);
		const { enc_path: _ignore, ...rest } = rawEntry;
		entries[path] = rest;
	}
	return { entries, repairs: [...repairs] };
}

/** 明文 puts → 远端 token puts（附 enc_path） */
export async function encodePuts(puts: PutMutation[], mode: number): Promise<PutMutation[]> {
	if (!enabled(mode)) return puts;
	const c = await cipher();
	const out: PutMutation[] = [];
	for (const p of puts) {
		const { key, encPath } = await c.encode(p.path);
		out.push({ ...p, path: key, enc_path: encPath });
	}
	return out;
}

/** 明文 delete 路径 → 远端 token deletes（附 enc_path） */
export async function encodeDeletes(
	paths: string[],
	mode: number,
): Promise<{ path: string; enc_path: string }[]> {
	if (!enabled(mode)) return paths.map((p) => ({ path: p, enc_path: "" }));
	const c = await cipher();
	const out: { path: string; enc_path: string }[] = [];
	for (const path of paths) {
		const { key, encPath } = await c.encode(path);
		out.push({ path: key, enc_path: encPath });
	}
	return out;
}

/**
 * 历史版本 / 已删除记录里的路径还原。
 * `path_encrypted=false` 是迁移前的旧明文行，原样返回；true 时必须解密并与 token 校验。
 * 绝不在失败时回退展示 token（会把不可读的 token 当文件名）。
 */
export async function decodeStoredPath(
	rawPath: string,
	encPath: string | undefined,
	pathEncrypted: boolean,
): Promise<string> {
	if (!pathEncrypted) return rawPath;
	if (!encPath) throw new PathDecodeError("缺少 enc_path，无法还原历史路径");
	return (await vaultKeys.pathCryptoUnlocked()).openEntry(rawPath, encPath);
}

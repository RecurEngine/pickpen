// 路径与文件名端到端加密内核（纯密码学，WebCrypto，桌面与移动端同一套代码，无新增依赖）。
//
// 每条远端路径由两部分组成：
//   1. 分层 token（Manifest key / PutMutation.path）：按路径段确定性 HMAC，
//      父级 token 参与下一段，保证同名文件在不同目录得到不同 token；服务端无法反解。
//   2. enc_path：完整明文路径的确定性 AES-256-GCM 密文，随条目下发，供客户端还原路径；
//      客户端解出后必须校验 token(明文路径) 与远端 key 一致。
//
// 两种产物都必须确定性：同一仓库同一路径在任何设备、任何时间得到同一 token 与 enc_path，
// 这是无状态收敛与目标 root 可比的前提。
//
// 与内容密钥域分离：pathKey = HKDF(DEK, "pickpen-path-key-v1")，内容 blob 的 seed/key
// 使用不同 info，互不影响。

import { nfcPath } from "../sync/path";

/** 单个路径段 token 的原始字节数（HMAC-SHA256 截断到 96 bit） */
export const PATH_TOKEN_BYTES = 12;
/** base64url 无填充后的固定字符数：12 字节 = 16 字符 */
export const PATH_TOKEN_CHARS = 16;
/** 路径加密密文魔数与格式版本 */
export const PATH_ENC_MAGIC = 0xe3;
export const PATH_ENC_VERSION = 1;
/** 密文头部：魔数 1 + 版本 1 + 种子 24 */
export const PATH_ENC_HEADER_BYTES = 26;
/** 明文路径填充粒度：服务端只能看到路径长度的粗粒度区间 */
export const PATH_PAD_BLOCK = 32;
/** token 路径最大层数：16 字符/段 + 分隔符，30 层 = 509 字符 ≤ 协议 512 字节上限 */
export const PATH_TOKEN_MAX_DEPTH = 30;

const TE = new TextEncoder();
const TD = new TextDecoder();

const TOKEN_INFO = TE.encode("pickpen-path-token-v1");
const SEED_INFO = TE.encode("pickpen-path-seed-v1");
const ENC_INFO = TE.encode("pickpen-path-enc-v1");
const KEY_INFO = TE.encode("pickpen-path-key-v1");

/** 路径无法编码（非法 NFC/超长/超过 token 层数） */
export class PathUnencodableError extends Error {
	constructor(readonly path: string, reason: string) {
		super(`路径无法编码：${reason}（${path}）`);
		this.name = "PathUnencodableError";
	}
}

/** enc_path 损坏、密钥不匹配或 token 校验失败 */
export class PathDecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathDecodeError";
	}
}

export interface EncodedPath {
	/** 分层 token（manifest key） */
	key: string;
	/** 明文路径密文（base64url，无填充） */
	encPath: string;
}

/** 路径是否可以编码为 token（NFC、协议合法、层数不超限） */
export function canEncodePath(path: string): boolean {
	if (path.normalize("NFC") !== path) return false;
	if (nfcPath(path) === null) return false;
	return path.split("/").length <= PATH_TOKEN_MAX_DEPTH;
}

/**
 * PathCrypto 绑定一个仓库内容密钥的路径编解码器。
 * 内部缓存明文→token/enc_path 与 token→明文，避免每轮对全库重复 HMAC/AES。
 */
export class PathCrypto {
	private readonly cache = new Map<string, Promise<EncodedPath>>();
	private readonly reverse = new Map<string, string>();

	private constructor(
		private readonly hmacKey: CryptoKey,
		private readonly hkdfKey: CryptoKey,
	) {}

	/** 由仓库内容密钥派生路径子密钥（HKDF-SHA256，域分离） */
	static async create(dek: Uint8Array): Promise<PathCrypto> {
		const base = await crypto.subtle.importKey("raw", dek as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
		const bits = await crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: KEY_INFO },
			base,
			256,
		);
		const raw = new Uint8Array(bits);
		const hmacKey = await crypto.subtle.importKey(
			"raw",
			raw,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const hkdfKey = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
			"deriveBits",
		]);
		return new PathCrypto(hmacKey, hkdfKey);
	}

	/** 明文路径 → token + enc_path（带缓存；失败不缓存） */
	encode(path: string): Promise<EncodedPath> {
		if (!canEncodePath(path)) {
			return Promise.reject(new PathUnencodableError(path, "NFC 非法、路径超长或目录层数超过 30"));
		}
		const hit = this.cache.get(path);
		if (hit) return hit;
		const p = (async (): Promise<EncodedPath> => {
			const key = await this.token(path);
			const encPath = await this.seal(path);
			this.reverse.set(key, path);
			return { key, encPath };
		})().catch((err: unknown) => {
			this.cache.delete(path);
			throw err;
		});
		this.cache.set(path, p);
		return p;
	}

	/** 只取 token（root 计算/本地匹配用） */
	async token(path: string): Promise<string> {
		if (!canEncodePath(path)) {
			throw new PathUnencodableError(path, "NFC 非法、路径超长或目录层数超过 30");
		}
		let parent = "";
		for (const seg of path.split("/")) {
			const parentBytes = TE.encode(parent);
			const msg = concatBytes(
				TOKEN_INFO,
				encodeVarint(parentBytes.length),
				parentBytes,
				new Uint8Array([0]),
				TE.encode(seg),
			);
			const mac = new Uint8Array(await crypto.subtle.sign("HMAC", this.hmacKey, msg as Uint8Array<ArrayBuffer>));
			const token = base64Url(mac.subarray(0, PATH_TOKEN_BYTES));
			parent = parent === "" ? token : `${parent}/${token}`;
		}
		this.reverse.set(parent, path);
		return parent;
	}

	/** 只取 enc_path（提交 mutation 用） */
	async seal(path: string): Promise<string> {
		const pathBytes = TE.encode(path);
		const plain = padPath(pathBytes);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plain as Uint8Array<ArrayBuffer>));
		const seed = new Uint8Array(
			await crypto.subtle.sign("HMAC", this.hmacKey, concatBytes(SEED_INFO, digest) as Uint8Array<ArrayBuffer>),
		).subarray(0, 24);
		const bits = await crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt: seed, info: ENC_INFO },
			this.hkdfKey,
			256,
		);
		const key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt"]);
		const header = new Uint8Array(PATH_ENC_HEADER_BYTES);
		header[0] = PATH_ENC_MAGIC;
		header[1] = PATH_ENC_VERSION;
		header.set(seed, 2);
		const sealed = new Uint8Array(
			await crypto.subtle.encrypt(
				{
					name: "AES-GCM",
					iv: seed.subarray(0, 12),
					additionalData: header,
				},
				key,
				plain as Uint8Array<ArrayBuffer>,
			),
		);
		return base64Url(concatBytes(header, sealed));
	}

	/** enc_path → 明文路径（含格式、NFC、协议路径校验） */
	async open(encPath: string): Promise<string> {
		if (!/^[A-Za-z0-9_-]+$/.test(encPath)) throw new PathDecodeError("enc_path 含非 base64url 字符");
		let raw: Uint8Array;
		try {
			raw = base64UrlDecode(encPath);
		} catch {
			throw new PathDecodeError("enc_path 解码失败");
		}
		if (raw.length < PATH_ENC_HEADER_BYTES + 16 || raw[0] !== PATH_ENC_MAGIC || raw[1] !== PATH_ENC_VERSION) {
			throw new PathDecodeError("enc_path 头部非法");
		}
		const header = raw.subarray(0, PATH_ENC_HEADER_BYTES);
		const seed = raw.subarray(2, PATH_ENC_HEADER_BYTES);
		const bits = await crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt: seed as Uint8Array<ArrayBuffer>, info: ENC_INFO },
			this.hkdfKey,
			256,
		);
		const key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt"]);
		let plain: Uint8Array;
		try {
			plain = new Uint8Array(
				await crypto.subtle.decrypt(
					{
						name: "AES-GCM",
						iv: seed.subarray(0, 12) as Uint8Array<ArrayBuffer>,
						additionalData: header as Uint8Array<ArrayBuffer>,
					},
					key,
					raw.subarray(PATH_ENC_HEADER_BYTES) as Uint8Array<ArrayBuffer>,
				),
			);
		} catch {
			throw new PathDecodeError("enc_path 认证失败");
		}
		if (plain.length === 0 || plain.length % PATH_PAD_BLOCK !== 0) throw new PathDecodeError("enc_path 填充长度非法");
		const len = decodeVarint(plain, 0);
		if (len === null || len.value <= 0 || len.size + len.value > plain.length) {
			throw new PathDecodeError("enc_path 长度前缀非法");
		}
		const start = len.size;
		const end = start + len.value;
		for (let i = end; i < plain.length; i++) {
			if (plain[i] !== 0) throw new PathDecodeError("enc_path 填充非零");
		}
		const path = TD.decode(plain.subarray(start, end));
		if (path.normalize("NFC") !== path || nfcPath(path) === null) {
			throw new PathDecodeError("enc_path 解出的路径非法");
		}
		return path;
	}

	/** 解出明文并校验 token(明文) === 远端 key（防止服务端篡改/错配） */
	async openEntry(remoteKey: string, encPath: string): Promise<string> {
		const path = await this.open(encPath);
		const computed = await this.token(path);
		if (computed !== remoteKey) throw new PathDecodeError("enc_path 与 token 不匹配");
		return path;
	}

	/** token → 已知明文路径（本地/Base 索引；未命中返回 undefined） */
	lookup(remoteKey: string): string | undefined {
		return this.reverse.get(remoteKey);
	}

	/** 把一批明文路径灌入反向索引（Base 恢复后的 manifest 解码加速用） */
	async indexPaths(paths: Iterable<string>): Promise<void> {
		for (const p of paths) {
			try {
				await this.token(p);
			} catch {
				// 无法编码的路径由扫描 blocked 逻辑处理，索引时跳过
			}
		}
	}
}

// ===== 编码辅助 =====

function concatBytes(...parts: Uint8Array[]): Uint8Array {
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

function encodeVarint(n: number): Uint8Array {
	const out: number[] = [];
	let v = Math.trunc(n);
	while (v >= 0x80) {
		out.push((v % 128) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v % 128);
	return new Uint8Array(out);
}

function decodeVarint(buf: Uint8Array, offset: number): { value: number; size: number } | null {
	let value = 0;
	let shift = 1;
	for (let i = offset; i < buf.length && i < offset + 4; i++) {
		const b = buf[i];
		value += (b & 0x7f) * shift;
		if ((b & 0x80) === 0) return { value, size: i - offset + 1 };
		shift *= 128;
	}
	return null;
}

/** 明文路径填充：varint(len) || path || 0x00 到 32 字节边界 */
function padPath(pathBytes: Uint8Array): Uint8Array {
	const prefix = encodeVarint(pathBytes.length);
	const need = prefix.length + pathBytes.length;
	const padded = Math.max(PATH_PAD_BLOCK, Math.ceil(need / PATH_PAD_BLOCK) * PATH_PAD_BLOCK);
	const out = new Uint8Array(padded);
	out.set(prefix, 0);
	out.set(pathBytes, prefix.length);
	return out;
}

function base64Url(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
	const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

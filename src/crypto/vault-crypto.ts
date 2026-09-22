// 仓库端到端加密内核（纯函数，WebCrypto 实现，桌面与移动端同一套代码，无新增依赖）。
//
// 服务端不持有任何可解密内容的信息：仓库密码永不上传，只上传被密码派生密钥包装过的
// 内容密钥（服务端只存不解），文件内容一律以密文上传。
//
// 密钥层级：
//   口令 + 盐 --PBKDF2-HMAC-SHA256--> 口令密钥 KEK
//   内容密钥 DEK = 32 字节随机数，用 KEK 以 AES-256-GCM 包装后随仓库元数据保存
//
// 内容加密必须是确定性的：同一个明文在同一个仓库里任何时候都必须得到同一段密文，
// 否则「相同内容只存一份」的去重、以及「文件没变就不重传」的快路径全部失效，
// 双端还会把同一份内容判成冲突。做法是用明文哈希派生一个密钥化的种子：
//   p     = SHA-256(明文)
//   seed  = HMAC-SHA256(DEK, "pickpen-blob-seed-v1" ‖ p)[0:24]
//   key   = HKDF-SHA256(ikm=DEK, salt=seed, info="pickpen-blob-key-v1")
//   nonce = seed[0:12]
//   密文  = 0xE1 ‖ 0x01 ‖ seed ‖ AES-256-GCM(key, nonce, 明文, aad=头部 26 字节)
// 种子是密钥化伪随机值而不是明文哈希本身，服务端即使拿到密文也无法拿已知明文做字典比对；
// 头部的魔数让密文自描述，便于识别转换加密前遗留的明文历史版本。

/** 加密协议版本（与仓库元数据 key_params.version 同值） */
export const E2EE_VERSION = 1;

/** 口令派生算法编号：1 = PBKDF2-HMAC-SHA256 */
export const KDF_PBKDF2 = 1;

/** 口令派生迭代次数（OWASP 对 PBKDF2-HMAC-SHA256 的建议量级） */
export const KDF_ITERATIONS = 600_000;

/** 密文魔数与格式版本（blob[0]、blob[1]） */
export const BLOB_MAGIC = 0xe1;
export const BLOB_FORMAT_VERSION = 1;

/** 密文头部长度：魔数 1 + 格式版本 1 + 种子 24 */
export const BLOB_HEADER_BYTES = 26;

/** 单个内容的固定加密开销上限（头部 + GCM 认证标签），用于与单文件大小上限比较 */
export const BLOB_OVERHEAD_BYTES = BLOB_HEADER_BYTES + 16;

const SALT_BYTES = 16;
const DEK_BYTES = 32;
const WRAP_NONCE_BYTES = 12;
const SEED_BYTES = 24;
const GCM_TAG_BYTES = 16;

/** 包装内容密钥时的附加认证数据（域分隔，避免包装结果被挪作他用） */
const WRAP_AAD = new TextEncoder().encode("pickpen-dek-v1");
const SEED_INFO = new TextEncoder().encode("pickpen-blob-seed-v1");
const BLOB_KEY_INFO = new TextEncoder().encode("pickpen-blob-key-v1");

/** 仓库加密参数（协议 VaultKeyParams 的客户端镜像，各字段为十六进制小写字符串） */
export interface VaultKeyParams {
	version: number;
	kdf: number;
	kdfSalt: string;
	kdfIterations: number;
	wrapNonce: string;
	wrappedKey: string;
}

/** 密码错误（包装密钥的认证标签校验失败）：与"参数损坏"区分，供 UI 提示用 */
export class WrongPasswordError extends Error {
	constructor() {
		super("仓库密码不正确");
		this.name = "WrongPasswordError";
	}
}

export function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return hex;
}

export function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length >> 1);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/** 口令 + 盐 → KEK（AES-GCM 包装密钥） */
async function deriveKek(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
	const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: salt as Uint8Array<ArrayBuffer>, iterations, hash: "SHA-256" },
		base,
		256,
	);
	return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** 随机生成内容密钥并用口令包装，返回可随仓库保存的参数（新建加密仓库 / 改密码用） */
export async function wrapDekWithPassword(dek: Uint8Array, password: string): Promise<VaultKeyParams> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const nonce = crypto.getRandomValues(new Uint8Array(WRAP_NONCE_BYTES));
	const kek = await deriveKek(password, salt, KDF_ITERATIONS);
	const wrapped = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: WRAP_AAD },
		kek,
		dek as Uint8Array<ArrayBuffer>,
	);
	return {
		version: E2EE_VERSION,
		kdf: KDF_PBKDF2,
		kdfSalt: bytesToHex(salt),
		kdfIterations: KDF_ITERATIONS,
		wrapNonce: bytesToHex(nonce),
		wrappedKey: bytesToHex(new Uint8Array(wrapped)),
	};
}

/** 生成全新的仓库密钥（随机内容密钥 + 用口令包装），供新建加密仓库使用 */
export async function createVaultKey(password: string): Promise<{ params: VaultKeyParams; dek: Uint8Array }> {
	const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
	const params = await wrapDekWithPassword(dek, password);
	return { params, dek };
}

/**
 * 用口令解开内容密钥。密码错误与参数损坏都表现为 GCM 认证失败，
 * 但对用户而言只有一种可能：密码不对（参数来自服务端，损坏会先于长度校验暴露）。
 */
export async function unwrapDek(password: string, params: VaultKeyParams): Promise<Uint8Array> {
	if (params.version !== E2EE_VERSION || params.kdf !== KDF_PBKDF2) {
		throw new Error(`不支持的仓库加密参数（version=${params.version} kdf=${params.kdf}）`);
	}
	const kek = await deriveKek(password, hexToBytes(params.kdfSalt), params.kdfIterations);
	try {
		const dek = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: hexToBytes(params.wrapNonce) as Uint8Array<ArrayBuffer>,
				additionalData: WRAP_AAD,
			},
			kek,
			hexToBytes(params.wrappedKey) as Uint8Array<ArrayBuffer>,
		);
		if (dek.byteLength !== DEK_BYTES) throw new Error("内容密钥长度异常");
		return new Uint8Array(dek);
	} catch {
		throw new WrongPasswordError();
	}
}

/** blob 是否为加密内容（密文自描述：魔数 + 格式版本） */
export function isEncryptedBlob(blob: Uint8Array): boolean {
	return blob.length >= BLOB_HEADER_BYTES + GCM_TAG_BYTES && blob[0] === BLOB_MAGIC && blob[1] === BLOB_FORMAT_VERSION;
}

/**
 * 内容密钥的寻址代次指纹：同一个内容密钥恒定得到同一个值，换密钥必然不同。
 * 客户端把「写入本地基线时用的代次」落盘，二者不一致就强制重算全部寻址哈希——
 * 这是判断「内容寻址口径是否变了」的唯一可靠依据（改密码只换信封，代次不变）。
 */
export async function keyEpoch(dek: Uint8Array): Promise<string> {
	const hkdfKey = await crypto.subtle.importKey("raw", dek as Uint8Array<ArrayBuffer>, "HKDF", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(0),
			info: new TextEncoder().encode("pickpen-key-epoch-v1"),
		},
		hkdfKey,
		128,
	);
	return bytesToHex(new Uint8Array(bits));
}

/** 明文哈希 → 密钥化种子（确定性；同一明文在同一仓库内恒定） */
async function deriveSeed(dek: Uint8Array, plainHash: Uint8Array): Promise<Uint8Array> {
	const hmacKey = await crypto.subtle.importKey(
		"raw",
		dek as Uint8Array<ArrayBuffer>,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		hmacKey,
		concat(SEED_INFO, plainHash) as Uint8Array<ArrayBuffer>,
	);
	return new Uint8Array(mac).subarray(0, SEED_BYTES);
}

/** 种子 → 单个内容的一次性加密密钥 */
async function deriveBlobKey(dek: Uint8Array, seed: Uint8Array): Promise<CryptoKey> {
	const hkdfKey = await crypto.subtle.importKey("raw", dek as Uint8Array<ArrayBuffer>, "HKDF", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: seed as Uint8Array<ArrayBuffer>,
			info: BLOB_KEY_INFO,
		},
		hkdfKey,
		256,
	);
	return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** 加密单个内容（确定性：同明文同密钥 → 同密文） */
export async function sealBlob(dek: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
	const plainHash = new Uint8Array(
		await crypto.subtle.digest("SHA-256", plaintext as Uint8Array<ArrayBuffer>),
	);
	const seed = await deriveSeed(dek, plainHash);
	const header = new Uint8Array(BLOB_HEADER_BYTES);
	header[0] = BLOB_MAGIC;
	header[1] = BLOB_FORMAT_VERSION;
	header.set(seed, 2);
	const key = await deriveBlobKey(dek, seed);
	const sealed = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: seed.subarray(0, 12) as Uint8Array<ArrayBuffer>,
			additionalData: header,
		},
		key,
		plaintext as Uint8Array<ArrayBuffer>,
	);
	const out = new Uint8Array(header.length + sealed.byteLength);
	out.set(header, 0);
	out.set(new Uint8Array(sealed), header.length);
	return out;
}

/** 解密单个内容；密文被篡改或密钥不匹配时认证失败抛错（不会返回错误内容） */
export async function openBlob(dek: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
	if (!isEncryptedBlob(blob)) throw new Error("内容不是密文，无法解密");
	const header = blob.subarray(0, BLOB_HEADER_BYTES);
	const seed = blob.subarray(2, BLOB_HEADER_BYTES);
	const key = await deriveBlobKey(dek, seed);
	const plain = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: seed.subarray(0, 12) as Uint8Array<ArrayBuffer>,
			additionalData: header as Uint8Array<ArrayBuffer>,
		},
		key,
		blob.subarray(BLOB_HEADER_BYTES) as Uint8Array<ArrayBuffer>,
	);
	return new Uint8Array(plain);
}

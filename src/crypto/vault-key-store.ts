// 绑定仓库的密钥运行时状态（内存 + 可选的设备本地记忆）。
//
// 仓库密码用于解开内容密钥；解锁后两者都只在本进程内存中存活，是否写进设备本地
// localStorage 由「在本设备记住仓库密码」决定。绝不写入 data.json（data.json 会随 vault
// 被 iCloud 同步到其他设备，写入等于把密钥复制到所有端）。
//
// 记忆记录里既有内容密钥，也有密码本身（密码只供「查看密码」展示，不再参与解密）：二者对该
// 仓库的解密能力等价，因此放在同一条记录里、同一生命周期，关闭「记住」即整条清除。
//
// 同步内核不直接感知加密：加解密在这里按「仓库是否加密」统一收口，
// 未加密仓库的行为与改造前逐字节一致。

import { debugLog } from "../debug-log";
import { sha256Hex } from "../sync/content-hash";
import type { KeyValueStore } from "../session-store";
import { isEncryptedBlob, keyEpoch, openBlob, sealBlob, unwrapDek, type VaultKeyParams } from "./vault-crypto";

export const VAULT_KEY_PREFIX = "pickpen:vaultkey:v1:";

export function vaultKeyStorageKey(scopeKey: string): string {
	return `${VAULT_KEY_PREFIX}${scopeKey}`;
}

/** 「在本设备记住仓库密码」这一偏好本身的设备本地存储（与密钥记录分开：关闭记住后仍保留用户的选择） */
export const VAULT_REMEMBER_PREF_PREFIX = "pickpen:vaultpref:v1:";

export function vaultRememberPrefKey(scopeKey: string): string {
	return `${VAULT_REMEMBER_PREF_PREFIX}${scopeKey}`;
}

/** 设备本地的「记住」偏好（不含任何密钥材料） */
interface RememberPref {
	schema: 1;
	remember: boolean;
}

/** 设备本地记住的密钥材料（仅在用户开启「在本设备记住仓库密码」时写入） */
interface RememberedKey {
	schema: 1;
	vaultId: string;
	keyVersion: string;
	dek: string; // 十六进制
	password?: string; // 仓库密码明文，仅供「查看密码」；与 dek 同一条记录、同一生命周期
}

/** 远端仓库的加密状态（来自 ListVaults / GetVaultHead） */
export interface RemoteVaultState {
	vaultId: string;
	encrypted: boolean;
	keyVersion: string;
}

class MemoryKV implements KeyValueStore {
	private map = new Map<string, string>();
	getItem(k: string): string | null {
		return this.map.get(k) ?? null;
	}
	setItem(k: string, v: string): void {
		this.map.set(k, v);
	}
	removeItem(k: string): void {
		this.map.delete(k);
	}
}

export class VaultKeyStore {
	private kv: KeyValueStore = new MemoryKV();
	private storageKey = "";
	private prefKey = "";
	private vaultId = "";
	private encrypted = false;
	private remoteVersion = "0";
	private params?: VaultKeyParams;
	private dek?: Uint8Array;
	/** 当前内容密钥的寻址代次指纹（未加密/未解锁为 ""）；见下方 getEpoch 说明 */
	private epoch = "";
	private unlockedVersion = "";
	/** 「在本设备记住仓库密码」：默认开启，实际初值以设备本地偏好为准（见 configure） */
	private rememberEnabled = true;
	/** 本机持有的仓库密码，仅供「查看密码」展示（解锁时记录，上锁/退出登录即清除）；绝不写日志 */
	private password = "";

	/** configure 注入设备本地存储与 vault 作用域后缀（onload 时调用一次） */
	configure(kv: KeyValueStore | null, scopeKey: string): void {
		this.kv = kv ?? new MemoryKV();
		this.storageKey = vaultKeyStorageKey(scopeKey);
		this.prefKey = vaultRememberPrefKey(scopeKey);
		this.rememberEnabled = this.readRememberPref();
	}

	// ===== 远端状态 =====

	/**
	 * 同步远端仓库加密状态。返回 true = 本地基线必须重建（密钥已在别处变更、或换了仓库）——
	 * 内容寻址整体换过密钥，旧基线与旧解锁态一律作废。
	 *
	 * 「启动后第一次拿到该仓库状态」不算变更：磁盘上的 Base 仍是同一密钥写下的，
	 * 误判会让加密仓库每次启动都重算全量内容哈希。
	 */
	syncRemote(state: RemoteVaultState): boolean {
		const first = this.vaultId === "";
		const switched = !first && state.vaultId !== this.vaultId;
		const wasEncrypted = this.encrypted;
		if (first || switched) {
			this.lock();
			this.params = undefined;
			// 「在本设备记住」是设备级偏好，换绑仓库不作废：新仓库沿用同一偏好（默认开启）
			this.vaultId = state.vaultId;
		}
		// 密钥版本迁移只可能发生在同一仓库的连续观察之间
		const versionTransition = !first && !switched && state.keyVersion !== this.remoteVersion;
		this.remoteVersion = state.keyVersion;
		this.encrypted = state.encrypted;

		if (!state.encrypted) {
			// 未加密仓库没有可解锁的状态；顺带清掉可能残留的记忆
			this.lock();
			this.clearRemembered();
			// 从加密仓库换到未加密仓库：寻址口径变了，基线同样作废
			return switched || versionTransition || wasEncrypted;
		}
		if (versionTransition) {
			// 密钥已在别处变更：旧内容密钥与旧记忆都失效
			this.lock();
			this.clearRemembered();
			return true;
		}
		return switched;
	}

	/**
	 * keyParams 来自仓库元数据（ListVaults）。只接受**当前绑定仓库**的参数：
	 * 参数是全局单例的一部分，若允许随便写入，给另一个仓库核验密码就会顶掉本仓库的参数，
	 * 之后用正确密码也解不开（表现为「密码不正确」且无法自愈）。
	 */
	setParams(vaultId: string, params: VaultKeyParams | undefined): void {
		if (vaultId !== this.vaultId) return;
		this.params = params;
	}

	getParams(): VaultKeyParams | undefined {
		return this.params;
	}

	/**
	 * 寻址代次：内容密钥的指纹（未加密或未解锁时为 ""）。
	 * 它比 key_version 更精确——改密码只换信封、内容密钥不变，代次不变，
	 * 因此不会触发一次无谓的整库重算；而换密钥（转换/别处新建）代次必然改变。
	 * 同步内核把写入 Base 时的代次落盘，二者不一致即强制重算全部寻址哈希。
	 */
	getEpoch(): string {
		return this.epoch;
	}

	get boundVaultId(): string {
		return this.vaultId;
	}

	isEncrypted(): boolean {
		return this.encrypted;
	}

	/** 需要同步却尚未解锁（未解锁时同步内核必须整体暂停，不能读盘算哈希） */
	isLocked(): boolean {
		return this.encrypted && !this.dek;
	}

	/** 是否已就绪（未加密仓库恒为就绪） */
	isReady(): boolean {
		return !this.isLocked();
	}

	get keyVersion(): string {
		return this.remoteVersion;
	}

	// ===== 解锁 / 上锁 =====

	/** unlock 用仓库密码解开内容密钥；密码错误抛 WrongPasswordError（不写入任何状态） */
	async unlock(password: string): Promise<void> {
		if (!this.encrypted) return;
		if (!this.params) throw new Error("缺少仓库加密参数，请刷新仓库列表后重试");
		const dek = await unwrapDek(password, this.params);
		this.dek = dek;
		this.unlockedVersion = this.remoteVersion;
		this.password = password; // 仅供「查看密码」；开启记住时随密钥一起落盘
		this.epoch = await keyEpoch(dek);
		this.saveRemembered();
	}

	lock(): void {
		this.dek = undefined;
		this.unlockedVersion = "";
		this.epoch = "";
		this.password = ""; // 与内容密钥同进同出：上锁后不再展示密码
	}

	/** dek 未解锁 / 未加密仓库返回 undefined */
	getDek(): Uint8Array | undefined {
		return this.dek;
	}

	/** 本机持有的仓库密码（没输过 / 未解锁 / 旧记忆里没存时返回 ""）；仅供「查看密码」展示 */
	getVaultPassword(): string {
		return this.password;
	}

	requireDek(): Uint8Array {
		if (!this.dek) throw new Error("仓库未解锁，请先输入仓库密码");
		return this.dek;
	}

	// ===== 在本设备记住 =====

	get remember(): boolean {
		return this.rememberEnabled;
	}

	/**
	 * 开启/关闭「在本设备记住仓库密码」。开启时立即落盘当前密钥与密码，
	 * 关闭时立即清除；仓库本身未加密或未解锁时只记录开关状态。
	 * 该选择本身是设备本地偏好，跨重启保留。
	 */
	setRemember(enabled: boolean): void {
		this.rememberEnabled = enabled;
		this.writeRememberPref(enabled);
		if (enabled) this.saveRemembered();
		else this.clearRemembered();
	}

	/** 尝试用设备本地记住的内容密钥解锁；成功返回 true。密钥版本不符（别处改过密码）时清除并返回 false */
	async tryRestoreRemembered(): Promise<boolean> {
		if (!this.encrypted || this.dek) return !!this.dek;
		const saved = this.readRemembered();
		if (!saved) return false;
		this.rememberEnabled = true;
		this.dek = hexToBytes(saved.dek);
		// 升级前写下的记录里没有密码，此时「查看密码」不出现，直到用户重新输入一次
		if (typeof saved.password === "string") this.password = saved.password;
		this.unlockedVersion = saved.keyVersion;
		this.epoch = await keyEpoch(this.dek);
		debugLog.log("[pickpen] 已用本设备记住的仓库密钥解锁");
		return true;
	}

	/** 绑定仓库变化/退出登录时清空（内存与本地记忆一并清除；用户对「记住」的选择保留） */
	reset(): void {
		this.lock();
		this.clearRemembered();
		this.rememberEnabled = this.readRememberPref();
		this.params = undefined;
		this.vaultId = "";
		this.encrypted = false;
		this.remoteVersion = "0";
	}

	private readRemembered(): RememberedKey | null {
		try {
			const raw = this.kv.getItem(this.storageKey);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as Partial<RememberedKey>;
			if (parsed?.schema !== 1 || typeof parsed.dek !== "string") return null;
			// 形状必须先校验：坏掉的记忆会被当成内容密钥直接用，不会像 unwrapDek 那样报错，
			// 结果是用错误的密钥加密上传，直到换设备才发现所有内容都解不开
			if (!/^[0-9a-f]{64}$/.test(parsed.dek)) {
				this.clearRemembered();
				return null;
			}
			if (parsed.vaultId !== this.vaultId || parsed.keyVersion !== this.remoteVersion) return null;
			return parsed as RememberedKey;
		} catch {
			return null;
		}
	}

	private saveRemembered(): void {
		if (!this.rememberEnabled || !this.dek || !this.encrypted) return;
		const payload: RememberedKey = {
			schema: 1,
			vaultId: this.vaultId,
			keyVersion: this.remoteVersion,
			dek: bytesToHex(this.dek),
		};
		if (this.password) payload.password = this.password;
		try {
			this.kv.setItem(this.storageKey, JSON.stringify(payload));
		} catch {
			debugLog.warn("[pickpen] 本设备 localStorage 不可用，无法记住仓库密码");
		}
	}

	private clearRemembered(): void {
		try {
			this.kv.removeItem(this.storageKey);
		} catch {
			// 清理失败不影响主流程
		}
	}

	// ===== 「记住」偏好（设备本地，独立于密钥记录） =====

	/** 读偏好：无记录 = 默认开启；记录损坏按关闭处理，不悄悄回到「默认开启」 */
	private readRememberPref(): boolean {
		let raw: string | null = null;
		try {
			raw = this.kv.getItem(this.prefKey);
		} catch {
			return true; // 存储不可用（已降级为内存）时按默认开启
		}
		if (raw === null) return true;
		try {
			const parsed = JSON.parse(raw) as Partial<RememberPref>;
			if (parsed?.schema !== 1 || typeof parsed.remember !== "boolean") throw new Error("shape");
			return parsed.remember;
		} catch {
			// 用户可能正是为了不在本机留密码才关掉它，坏数据不能当成「没关过」
			this.writeRememberPref(false);
			return false;
		}
	}

	private writeRememberPref(enabled: boolean): void {
		const payload: RememberPref = { schema: 1, remember: enabled };
		try {
			this.kv.setItem(this.prefKey, JSON.stringify(payload));
		} catch {
			// 写失败只影响下次启动的初值，不影响本次会话
		}
	}
}

function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return hex;
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length >> 1);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** 绑定仓库的内容密钥状态单例（同步内核与 UI 共用） */
export const vaultKeys = new VaultKeyStore();

// ===== 内容字节流的统一出入口 =====

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** 待上传内容的密文与寻址信息（未加密仓库即明文本身） */
export interface SealedContent {
	hash: string;
	bytes: Uint8Array;
	size: number;
}

/**
 * 计算本地上传时使用的寻址信息。加密仓库下地址是密文哈希、size 是密文长度；
 * 未加密仓库与改造前完全一致（明文 SHA-256）。
 * 确定性加密保证同一明文每次都得到同一密文，因此这里重复加密不会产生第二个地址。
 */
export async function sealForRemote(content: Uint8Array | ArrayBuffer): Promise<SealedContent> {
	const bytes = toBytes(content);
	// 未加密仓库走明文（与改造前一致）；加密仓库未解锁必须抛错——
	// 一旦退回明文，本地内容就会以明文写进加密仓库，且此后无法自愈。
	if (!vaultKeys.isEncrypted()) return { hash: await sha256Hex(bytes), bytes, size: bytes.byteLength };
	const sealed = await sealBlob(vaultKeys.requireDek(), bytes);
	return { hash: await sha256Hex(sealed), bytes: sealed, size: sealed.byteLength };
}

/** 只取寻址哈希（本地扫描比对用，不上传） */
export async function remoteHash(content: Uint8Array | ArrayBuffer): Promise<string> {
	return (await sealForRemote(content)).hash;
}

/**
 * 把远端下载到的内容还原成本地可写的明文。
 * 未加密仓库、以及加密仓库里「转换为加密之前」遗留的历史版本都是明文，原样返回；
 * 只有带密文标记的内容才需要解密（密钥缺失时抛出，调用方须保证同步期间已解锁）。
 *
 * allowPlaintextFallback：仅用于**历史版本**读取。密文标记只有两个字节，转换前遗留的明文
 * 有极小概率恰好同前缀，此时按密文解密会认证失败。历史版本本来就可能是明文，所以失败后
 * 退回按明文读；当前快照的内容一定是密文，绝不能退回（会把损坏内容当明文写进 vault）。
 */
export async function openForLocal(blob: Uint8Array, allowPlaintextFallback = false): Promise<Uint8Array> {
	if (!vaultKeys.isEncrypted() || !isEncryptedBlob(blob)) return blob;
	try {
		return await openBlob(vaultKeys.requireDek(), blob);
	} catch (err) {
		if (!allowPlaintextFallback) throw err;
		debugLog.warn("[pickpen] 历史版本按密文解密失败，按明文读取");
		return blob;
	}
}

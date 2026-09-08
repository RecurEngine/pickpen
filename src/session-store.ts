// 登录会话的设备本地存储（localStorage，不随 vault iCloud 同步）。
//
// 背景：多端经 iCloud 同步同一 vault（含 `.obsidian/plugins/pickpen/data.json`）时，
// 若登录会话（token/deviceId/email/userId）也存 data.json，会被 iCloud 双向覆盖 →
// 两端 deviceId 与 token 相同 → 后端把两端当同一设备：refresh token 按 device 隔离、
// 一次性轮换互相顶下线（11002），sync-base 的 device 校验也因 device 相同而失效 → 基线串号。
// Obsidian 无 vault 外文件 API，localStorage（Electron 桌面 / Capacitor 移动各自的本地存储）
// 是唯一不随 vault 被同步的设备本地通道。会话迁到 localStorage 后每端 deviceId/token 独立，
// sync-base.json 的 device_id 校验（base-store）会自动丢弃串端基线并从远端全量重建（Base 只是缓存）。
//
// 注意：与同步内核 ReconcileSession 区分命名，本文件只负责“登录身份/设备身份”的设备本地存取。
// 所有会话字段的写点收敛到：AuthManager 改内存镜像 settings → captureFrom(settings) 单漏斗落 localStorage。

import { FileSystemAdapter, type App } from "obsidian";

import { debugLog } from "./debug-log";
import type { PluginSettings } from "./types";

export interface SessionState {
	schema: 1;
	email: string;
	userId: string;
	accessToken: string;
	accessExpiresAtMs: number;
	refreshToken: string;
	refreshExpiresAtMs: number;
	deviceId: string;
	// 绑定归属记忆（本地）：bindVault 时写入，仅存设备本地、不随 data.json 跨端传播。
	// 用于跨账号守卫：data.json 的 vaultId 若与本地会话的绑定记忆不符（如别端登别的账号绑过），启动即解绑提示重选。
	vaultOwner?: { vaultId: string; email: string };
	// 存储已满提醒按设备去重；YYYY-MM-DD，本地日期。容量恢复后清除。
	storageLimitAlertDate?: string;
}

/** 落 data.json 时必须剔除的会话键（= localStorage 独有，禁止随 vault 同步） */
export const SESSION_KEYS = [
	"email",
	"userId",
	"accessToken",
	"accessExpiresAtMs",
	"refreshToken",
	"refreshExpiresAtMs",
	"deviceId",
] as const;

/** 会话字段形状：captureFrom 入参（可传完整 PluginSettings，或仅含这些键的迁移对象） */
export type SessionFields = {
	email: string;
	userId: string;
	accessToken: string;
	accessExpiresAtMs: number;
	refreshToken: string;
	refreshExpiresAtMs: number;
	deviceId: string;
};

/** 可注入的键值存储（浏览器用 localStorage；单测在 node 下注入内存实现） */
export interface KeyValueStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

// stripSessionKeys 去掉全部会话键与 persist 回调，返回可安全序列化进 data.json 的对象。
// 入参用宽对象（非 Record 接口，避免 PluginSettings 无索引签名导致类型报错）
export function stripSessionKeys<T extends object>(obj: T): Partial<T> {
	const src = obj as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(src)) {
		if ((SESSION_KEYS as readonly string[]).includes(key) || key === "persist") continue;
		out[key] = src[key];
	}
	return out as Partial<T>;
}

/** 迁移动作判定（纯函数，单测友好）。localStorage 为权威：已有会话 → 只清理晚到副本；否则按 data.json 是否有会话分流 */
export type MigrationAction = "import" | "cleanup" | "fresh";
export function planLegacyMigration(dataJsonHasSession: boolean, storedSessionExists: boolean): MigrationAction {
	if (storedSessionExists) return "cleanup"; // localStorage 已有 → 不导入，仅剔 data.json 残留（防 iCloud 晚到副本回灌）
	return dataJsonHasSession ? "import" : "fresh"; // 老用户首迁（导入并重生成 deviceId） / 全新未登录
}

// FNV-1a 32bit → hex（同步、确定性，用于把 vault 稳定标识散列为定长 key 后缀）
function fnv1aHex(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; // FNV 质数 16777619
	}
	return h.toString(16).padStart(8, "0");
}

// vaultScopeKey 把“当前 vault 在本设备的稳定标识”散列成 localStorage key 后缀。
// 桌面：FileSystemAdapter.getBasePath() = vault 磁盘绝对路径（稳定、跨会话）；
// 移动/异常：回退 vault.getName()。
// 注意不能用 plugin.manifest.dir（所有仓库都是同一相对路径，会串 vault）；也不能固定单 key
//（同设备多 vault 需各自独立账号/deviceId，sync-base 才能各自固定）。
export function vaultScopeKey(app: App): string {
	const adapter = app.vault.adapter;
	const scope = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : app.vault.getName();
	return fnv1aHex(`pickpen:${scope}`);
}

export const SESSION_KEY_PREFIX = "pickpen:session:v1:";

export function sessionKeyForScope(scopeKey: string): string {
	return `${SESSION_KEY_PREFIX}${scopeKey}`;
}

// memoryKV 仅内存实现：localStorage 不可用（隐私模式/禁用 storage）时的兜底，本次运行可登录但不跨重启
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

const EMPTY_SESSION = (): SessionState => ({
	schema: 1,
	email: "",
	userId: "",
	accessToken: "",
	accessExpiresAtMs: 0,
	refreshToken: "",
	refreshExpiresAtMs: 0,
	deviceId: "",
});

export class SessionStore {
	readonly available: boolean; // localStorage 可用性（false → 仅内存，本次运行有效）
	private state: SessionState = EMPTY_SESSION();
	private readonly kv: KeyValueStore;
	private readonly key: string;
	private warned = false;

	constructor(kv: KeyValueStore | null, scopeKey: string) {
		this.key = sessionKeyForScope(scopeKey);
		// 探测 localStorage：window.localStorage 在不可用时访问本身会抛错
		if (kv) {
			this.kv = kv;
			this.available = true;
		} else {
			this.kv = new MemoryKV();
			this.available = false;
		}
	}

	// load 读取并解析；损坏/缺 schema → 视为空并清除，保证以合法状态起步
	load(): void {
		let raw: string | null = null;
		try {
			raw = this.kv.getItem(this.key);
		} catch {
			this.warnOnce();
			return;
		}
		if (raw === null) return;
		try {
			const parsed = JSON.parse(raw) as Partial<SessionState>;
			if (!parsed || parsed.schema !== 1 || typeof parsed.deviceId !== "string") {
				this.resetState();
				return;
			}
			this.state = { ...EMPTY_SESSION(), ...parsed, schema: 1 };
		} catch {
			this.resetState(); // JSON 损坏自愈
		}
	}

	// resetState 置空并尽力清除键（JSON 损坏/schema 不符时调用，保证以合法空态起步）
	private resetState(): void {
		this.state = EMPTY_SESSION();
		try {
			this.kv.removeItem(this.key);
		} catch {
			this.warnOnce();
		}
	}

	/** 是否已登录（有 accessToken） */
	hasToken(): boolean {
		return !!this.state.accessToken;
	}

	get email(): string {
		return this.state.email;
	}
	get userId(): string {
		return this.state.userId;
	}
	get deviceId(): string {
		return this.state.deviceId;
	}
	get vaultOwner(): { vaultId: string; email: string } | undefined {
		return this.state.vaultOwner;
	}

	// applyTo 把 localStorage 会话灌回内存镜像 settings（onload 时，作为会话权威覆盖）
	applyTo(s: PluginSettings): void {
		s.email = this.state.email;
		s.userId = this.state.userId;
		s.accessToken = this.state.accessToken;
		s.accessExpiresAtMs = this.state.accessExpiresAtMs;
		s.refreshToken = this.state.refreshToken;
		s.refreshExpiresAtMs = this.state.refreshExpiresAtMs;
		s.deviceId = this.state.deviceId;
	}

	// captureFrom 把内存镜像（AuthManager 已改）写回 localStorage —— 会话写点的唯一落盘漏斗。
	// 不清 vaultOwner（由 setVaultOwner/clearVaultOwner 显式维护），保留 deviceId/email 语义不变。
	// 参数为会话字段形状：可传完整 PluginSettings，也可传仅含这些键的迁移对象（老 data.json 首迁）
	captureFrom(s: SessionFields): void {
		this.state.email = s.email;
		this.state.userId = s.userId;
		this.state.accessToken = s.accessToken;
		this.state.accessExpiresAtMs = s.accessExpiresAtMs;
		this.state.refreshToken = s.refreshToken;
		this.state.refreshExpiresAtMs = s.refreshExpiresAtMs;
		this.state.deviceId = s.deviceId;
		this.save();
	}

	// ensureDeviceId 生成并持久化设备 ID（新装/迁移重生成后调用；不再写 data.json）
	ensureDeviceId(): string {
		if (!this.state.deviceId) {
			this.state.deviceId = crypto.randomUUID();
			this.save();
		}
		return this.state.deviceId;
	}

	// setEmail 未登录时编辑邮箱也入会话域（预填记忆不随 data.json 跨端同步）
	setEmail(email: string): void {
		this.state.email = email;
		this.save();
	}

	setVaultOwner(vaultId: string, email: string): void {
		this.state.vaultOwner = { vaultId, email };
		this.save();
	}

	clearVaultOwner(): void {
		delete this.state.vaultOwner;
		this.save();
	}

	get storageLimitAlertDate(): string | undefined {
		return this.state.storageLimitAlertDate;
	}

	get storageLimitAlertActive(): boolean {
		return !!this.state.storageLimitAlertDate;
	}

	markStorageLimitAlertShown(date: string): void {
		this.state.storageLimitAlertDate = date;
		this.save();
	}

	clearStorageLimitAlert(): void {
		if (!this.state.storageLimitAlertDate) return;
		delete this.state.storageLimitAlertDate;
		this.save();
	}

	/** 彻底清除本 vault 的会话（卸载/测试用） */
	clearAll(): void {
		this.state = EMPTY_SESSION();
		try {
			this.kv.removeItem(this.key);
		} catch {
			this.warnOnce();
		}
	}

	private save(): void {
		try {
			this.kv.setItem(this.key, JSON.stringify(this.state));
		} catch {
			this.warnOnce();
		}
	}

	private warnOnce(): void {
		if (this.warned) return;
		this.warned = true;
		debugLog.warn("[pickpen] 本设备 localStorage 不可用，登录态无法跨重启保留，请检查是否禁用站点存储");
	}
}

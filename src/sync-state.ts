// 同步运行态（ribbon/状态栏/设置页订阅）

import type { BlockedPathInfo } from "./sync/blocked";
import type { SyncProgress } from "./sync/progress";
import type { TransferMark } from "./sync/transfer-journal";

import { DEBOUNCE_MS } from "./types";

// 暂停原因词汇表：pausedReason 非空即同步暂停。原因集中定义在这里，便于按类别判定
// 「该原因是否已过时」（见 shouldClearAccountPause），也避免同一句话在多处各写一遍。
export const PAUSED_NOT_SIGNED_IN = "未登录";
export const PAUSED_NO_VAULT = "请选择要绑定的仓库";
export const PAUSED_BY_LOCK = "仓库已加密，请输入密码解锁";
export const PAUSED_VAULT_MANAGER_BUSY = "仓库管理操作中";
export const PAUSED_VAULT_CONVERTING = "仓库加密转换中";

/** 由账号/绑定配置状态派生的暂停原因：状态一旦满足，这条暂停就已经过时 */
const ACCOUNT_PAUSED_REASONS: readonly string[] = [PAUSED_NOT_SIGNED_IN, PAUSED_NO_VAULT];

export function isAccountPausedReason(reason: string): boolean {
	return ACCOUNT_PAUSED_REASONS.includes(reason);
}

/**
 * 判断该不该清掉「未登录 / 请选择要绑定的仓库」这类派生暂停标志。
 *
 * 这类原因只在特定流程里被 resumeSync 解除（绑定成功、登录时沿用绑定……）。只要那条路径的
 * 解除被跳过——落盘 await 挂起或抛错、流程被中断——用户就会卡在「已绑定但仍显示已暂停」，
 * 而且 pausedReason 会一并关掉后台轮询（见 index.ts 的 canPoll），此后不再自动拉取远端改动。
 * 一次成功跑完的同步本身就证明登录态与绑定都有效，此时这类标志必然过时，清掉是安全的。
 */
export function shouldClearAccountPause(input: {
	running: boolean;
	lastError: string;
	accessToken: string;
	vaultId: string;
	pausedReason: string;
}): boolean {
	return (
		!input.running &&
		!input.lastError &&
		!!input.accessToken &&
		!!input.vaultId &&
		isAccountPausedReason(input.pausedReason)
	);
}

export class SyncState {
	/** 本地已观察到、尚未确认进入远端的路径数（仅展示；同步成功后归零） */
	pendingCount = 0;
	lastSyncAt = 0;
	lastError = "";
	pausedReason = ""; // 非空即同步暂停；原因取值见本文件顶部 PAUSED_* 词汇表
	blockedPaths: string[] = []; // 本轮未同步的路径（超限/读失败/大小写冲突/云端存量超限）
	/** 未同步路径的原因明细（与 blockedPaths 对应）：仅用于展示「哪个文件、为什么」 */
	blockedDetails: BlockedPathInfo[] = [];
	/** 当前套餐的单文件上限（字节）；0 表示未知，文案里省略具体数值 */
	maxFileSizeBytes = 0;
	/** 磁盘上待处理的冲突副本（存量，含其他设备产生的）。
	 * 只用于提示，**不参与 allSynced 判定**：冲突副本是「两边内容都在」的提醒，不是同步失败，
	 * 否则只要有未清理的副本，Ribbon 就永远不会显示「已全部同步」。 */
	conflictCopyPaths: string[] = [];
	storageLimitExceeded = false; // 用户总存储已满；成功完成一次同步后清除
	/** 上次运行被中断在传输中的大文件（进程被杀留下的痕迹；仅提示，不参与 allSynced） */
	interruptedTransfer: TransferMark | null = null;
	sessionRunning = false;
	progress: SyncProgress | null = null;
	localDebounceMs = DEBOUNCE_MS; // 当前生效值；有效服务端下发值可覆盖客户端默认
	private listeners: Array<() => void> = [];

	update(patch: Partial<SyncState>): void {
		Object.assign(this, patch);
		this.listeners.forEach((l) => l());
	}

	onChange(listener: () => void): void {
		this.listeners.push(listener);
	}

	off(listener: () => void): void {
		this.listeners = this.listeners.filter((l) => l !== listener);
	}

	/** 全部同步完成判定（spec §9.2/§10.1）：存在错误、pending 或阻塞时不得显示完成 */
	get allSynced(): boolean {
		return (
			!this.sessionRunning &&
			!this.lastError &&
			!this.pausedReason &&
			!this.storageLimitExceeded &&
			this.blockedPaths.length === 0 &&
			this.pendingCount === 0
		);
	}
}

export const syncState = new SyncState();

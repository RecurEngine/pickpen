// 同步运行态（ribbon/状态栏/设置页订阅）

import { DEBOUNCE_MS } from "./types";

export class SyncState {
	pendingCount = 0;
	lastSyncAt = 0;
	lastError = "";
	pausedReason = ""; // 非空即同步暂停（如「令牌失效」「请选择要绑定的仓库」）
	skippedLargeFiles: string[] = []; // 被当前套餐单文件上限阻塞的文件
	blockedPaths: string[] = []; // 被阻塞路径（超限/读失败/大小写冲突/file-dir 冲突）
	storageLimitExceeded = false; // 用户总存储已满；成功完成一次同步后清除
	sessionRunning = false;
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
			this.blockedPaths.length === 0
		);
	}
}

export const syncState = new SyncState();

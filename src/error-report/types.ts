// 异常上报的本地类型。与服务端 errorreport.ErrorReportItem 一一对应，但队列额外携带
// 重试状态；所有 int64 字段在 JS 侧用 number（毫秒时间戳）或十进制字符串（仓库 ID）表示。

export type ErrorPhase =
	| "startup"
	| "layout"
	| "sync"
	| "recover"
	| "network"
	| "transfer"
	| "auth"
	| "vault"
	| "ui"
	| "unknown";

export type ErrorLevel = "error" | "fatal";

export interface SanitizeSecrets {
	/** 绑定仓库名，精确替换为 <vault>；未绑定为空 */
	vaultName: string;
	/** 桌面端 vault 绝对路径，精确替换为 <vault-path>；移动端或取不到为空 */
	vaultBasePath: string;
}

export interface ReporterMeta {
	deviceId: string;
	pluginVersion: string;
	/** 绑定仓库 ID（十进制字符串），未绑定为空 */
	vaultId: string;
	platform: "desktop" | "mobile";
	os: string;
	signedIn: boolean;
	vaultBound: boolean;
	encrypted: boolean;
	locked: boolean;
	syncRunning: boolean;
	pendingCount: number;
	appVersion: string;
	locale: string;
}

export interface ErrorExtra {
	code?: number;
	httpStatus?: number;
	rpcMethod?: string;
	durationMs?: number;
	baseLoadResult?: string;
	vaultIdOverride?: string;
}

export interface QueuedReport {
	reportId: string;
	clientFingerprint: string;
	occurredAtMs: number;
	level: ErrorLevel;
	phase: ErrorPhase;
	errorName: string;
	message: string;
	code: number;
	httpStatus: number;
	stack: string;
	contextJson: string;
	deviceId: string;
	pluginVersion: string;
	platform: "desktop" | "mobile";
	os: string;
	signedIn: boolean;
	/** 十进制字符串；发送时转 bigint */
	vaultId: string;
	suppressedCount: number;
	attempts: number;
	nextAttemptAtMs: number;
	createdAtMs: number;
}

export interface FingerprintCount {
	session: number;
	day: number;
	lastAt: number;
}

export interface QueueState {
	schema: 1;
	reports: QueuedReport[];
	dayKey: string;
	dayCount: number;
	sessionCount: number;
	fingerprintCounts: Record<string, FingerprintCount>;
	suppressed: Record<string, number>;
	/** 网络类错误的 6 小时窗口，避免断网用户刷屏 */
	networkWindowStart: number;
	networkCount: number;
}

export interface SendResult {
	accepted: number;
	retryAfterMs: number;
}

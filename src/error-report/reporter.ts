// 异常上报单例：采集 → 脱敏 → 指纹/配额 → 本地队列 → 批量发送。
// 旁路原则：所有方法内部吞掉异常，只写 debugLog，绝不影响同步/登录/UI。
// 上报自身的失败不得再次进入采集（suspended 标志 + 本模块不调用 capture）。

import type { KeyValueStore } from "../session-store";
import { debugLog } from "../debug-log";
import { BUILD_TAG } from "../types";
import { isExpectedError, isNetworkPhase, isUnimplemented, normalizeError } from "./classify";
import { ErrorQueue } from "./queue";
import { sanitizeMessage, sanitizeText, truncateChars, truncateUtf8 } from "./sanitize";
import type {
	ErrorExtra,
	ErrorLevel,
	ErrorPhase,
	QueuedReport,
	ReporterMeta,
	SanitizeSecrets,
	SendResult,
} from "./types";

/** 构建期默认值：正式包默认开启，local/test 默认关闭；运行期由设置页开关接管（所有构建均可开关）。 */
const BUILD_ENABLED = process.env.PICKPEN_ERROR_REPORT === "1";

const MESSAGE_MAX_CHARS = 1024;
const STACK_MAX_BYTES = 16 * 1024;
const CONTEXT_MAX_BYTES = 2048;
const BATCH_SIZE = 10;
const MIN_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

export interface ReporterConfig {
	kv: KeyValueStore | null;
	scopeKey: string;
	secrets: () => SanitizeSecrets;
	meta: () => ReporterMeta;
	send: (items: QueuedReport[]) => Promise<SendResult>;
}

export class ErrorReporter {
	private config: ReporterConfig | null = null;
	private queue: ErrorQueue | null = null;
	private enabled = false;
	private suspended = false;
	private inFlight = false;
	private flushTimer: number | null = null;
	private retryTimer: number | null = null;

	/** buildEnabled 由构建期开关决定；测试可直接传入 true 验证采集/发送逻辑。 */
	constructor(private readonly buildEnabled: boolean = BUILD_ENABLED) {}

	init(config: ReporterConfig): void {
		this.config = config;
		this.queue = new ErrorQueue(config.kv, `pickpen:errorq:v1:${config.scopeKey}`);
		this.enabled = this.buildEnabled;
		if (typeof window !== "undefined") {
			this.retryTimer = window.setInterval(() => {
				void this.flush();
			}, MIN_FLUSH_INTERVAL_MS);
		}
		this.installDebugHook();
	}

	/** 设置页开关：关闭时立即停止采集并清空未发送队列。 */
	setEnabled(value: boolean): void {
		this.enabled = value;
		if (!this.enabled) this.queue?.clear();
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	/** 采集一个异常；预期错误、上报自身错误与未初始化状态都直接忽略。 */
	capture(phase: ErrorPhase, err: unknown, extra: ErrorExtra = {}): void {
		if (!this.canCapture() || isExpectedError(err)) return;
		try {
			const secrets = this.config!.secrets();
			const meta = this.config!.meta();
			const normalized = normalizeError(err);
			const message = truncateChars(sanitizeMessage(normalized.message, secrets), MESSAGE_MAX_CHARS);
			const stack = truncateUtf8(sanitizeText(normalized.stack, secrets), STACK_MAX_BYTES);
			if (!message && !stack) return;

			const level: ErrorLevel = phase === "startup" || phase === "layout" ? "fatal" : "error";
			const contextJson = truncateUtf8(JSON.stringify(this.buildContext(phase, meta, extra)), CONTEXT_MAX_BYTES);
			const report = this.queue!.enqueue({
				phase,
				level,
				errorName: truncateChars(sanitizeText(normalized.name, secrets), 64),
				message,
				stack,
				code: extra.code ?? normalized.code,
				httpStatus: extra.httpStatus ?? normalized.httpStatus,
				contextJson,
				deviceId: meta.deviceId,
				pluginVersion: meta.pluginVersion,
				platform: meta.platform,
				os: meta.os,
				signedIn: meta.signedIn,
				vaultId: extra.vaultIdOverride ?? meta.vaultId,
				network: isNetworkPhase(phase, err),
			});
			if (report) this.scheduleFlush();
		} catch (error) {
			this.warnInternal("capture", error);
		}
	}

	/** 采集一条无异常对象的诊断消息（如 Base 损坏）。 */
	captureMessage(phase: ErrorPhase, message: string, extra: ErrorExtra = {}): void {
		this.capture(phase, new Error(message), extra);
	}

	/** 批量发送队列中到期的记录；失败保留队列并退避。 */
	async flush(): Promise<void> {
		if (!this.enabled || !this.queue || this.inFlight) return;
		const items = this.queue.pending().slice(0, BATCH_SIZE);
		if (items.length === 0) return;
		const ids = items.map((item) => item.reportId);
		this.inFlight = true;
		// 发送期间禁止采集，避免上报失败再次入队形成反馈环。
		this.suspended = true;
		try {
			const result = await this.config!.send(items);
			if (result.retryAfterMs > 0) this.queue.markFailed(ids, result.retryAfterMs);
			else this.queue.markSent(ids);
		} catch (error) {
			if (isUnimplemented(error)) {
				// 旧服务端不认识新 RPC：丢弃队列并停止本会话上报，避免无限重试。
				this.queue.markSent(ids);
				this.enabled = false;
				debugLog.warn("[pickpen] 异常上报接口不可用，本次运行已停止上报");
			} else {
				this.queue.markFailed(ids, 0);
				this.warnInternal("flush", error);
			}
		} finally {
			this.suspended = false;
			this.inFlight = false;
		}
	}

	dispose(): void {
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		if (this.retryTimer !== null) window.clearInterval(this.retryTimer);
		this.flushTimer = null;
		this.retryTimer = null;
		// 卸载不保证异步完成，尽力而为发一次；队列本身已持久化，下次启动会补报。
		void this.flush();
	}

	private canCapture(): boolean {
		return this.buildEnabled && this.enabled && !this.suspended && this.config !== null && this.queue !== null;
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, 3_000);
	}

	private buildContext(phase: ErrorPhase, meta: ReporterMeta, extra: ErrorExtra): Record<string, unknown> {
		const pendingBucket = meta.pendingCount <= 0 ? "0" : meta.pendingCount < 10 ? "1-9" : "10+";
		const context: Record<string, unknown> = {
			environment: process.env.PICKPEN_ENV ?? "test",
			build_tag: BUILD_TAG || undefined,
			obsidian_version: meta.appVersion || undefined,
			locale: meta.locale || undefined,
			phase,
			vault_bound: meta.vaultBound,
			encrypted: meta.encrypted,
			locked: meta.locked,
			sync_running: meta.syncRunning,
			pending_bucket: pendingBucket,
			rpc_method: extra.rpcMethod,
			duration_ms: extra.durationMs,
			base_load_result: extra.baseLoadResult,
		};
		return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined && value !== ""));
	}

	private warnInternal(stage: string, error: unknown): void {
		// 只记错误类型名：内部错误消息也可能夹带路径/凭据。
		const name = (error as { name?: unknown })?.name;
		debugLog.warn(`[pickpen] 异常上报内部错误（${stage}）：${typeof name === "string" ? name : "unknown"}`);
	}

	private installDebugHook(): void {
		if (process.env.PICKPEN_ENV === "prod" || typeof window === "undefined") return;
		const host = window as unknown as Record<string, unknown>;
		host.__pickpenErrorReportDebug = {
			flush: () => this.flush(),
			pending: () => this.queue?.pending().length ?? 0,
			capture: (message: string) => this.captureMessage("unknown", message),
		};
	}
}

/** 插件级单例；index.ts 初始化，其他模块只通过 reportError 采集。 */
export const errorReporter = new ErrorReporter();

/** 跨模块便捷入口：未初始化/被禁用时自动 no-op。 */
export function reportError(phase: ErrorPhase, err: unknown, extra: ErrorExtra = {}): void {
	errorReporter.capture(phase, err, extra);
}

export function reportMessage(phase: ErrorPhase, message: string, extra: ErrorExtra = {}): void {
	errorReporter.captureMessage(phase, message, extra);
}

// 设备本地待发队列：localStorage 同步落盘，进程被杀后下次启动仍能补报。
// 只存脱敏后的字段；关闭上报开关时整体清空。

import { fnv1aHex, type KeyValueStore } from "../session-store";
import { clientFingerprint, normalizeMessage } from "./fingerprint";
import type { ErrorLevel, ErrorPhase, FingerprintCount, QueueState, QueuedReport } from "./types";

export const QUEUE_LIMIT = 30;
export const QUEUE_MAX_BYTES = 256 * 1024;
export const SESSION_LIMIT = 20;
export const DAY_LIMIT = 50;

const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const NETWORK_WINDOW_MS = 6 * 60 * 60 * 1000;
const NETWORK_LIMIT = 3;
const BACKOFF_MS = [5_000, 30_000, 120_000];

export interface EnqueueInput {
	phase: ErrorPhase;
	level: ErrorLevel;
	errorName: string;
	message: string;
	stack: string;
	code: number;
	httpStatus: number;
	contextJson: string;
	deviceId: string;
	pluginVersion: string;
	platform: "desktop" | "mobile";
	os: string;
	signedIn: boolean;
	vaultId: string;
	network: boolean;
}

function dayKeyOf(now: number): string {
	const date = new Date(now);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}${month}${day}`;
}

function defaultState(now: number): QueueState {
	return {
		schema: 1,
		reports: [],
		dayKey: dayKeyOf(now),
		dayCount: 0,
		sessionCount: 0,
		fingerprintCounts: {},
		suppressed: {},
		networkWindowStart: 0,
		networkCount: 0,
	};
}

function newReportID(): string {
	const cryptoObj = typeof window !== "undefined" ? window.crypto : undefined;
	if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
	// 兜底：仅用于极老的 WebView；满足服务端 36 位 UUID 校验
	const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
	return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

export class ErrorQueue {
	private state: QueueState;

	constructor(
		private readonly kv: KeyValueStore | null,
		private readonly key: string,
		private readonly now: () => number = () => Date.now(),
	) {
		this.state = this.load();
	}

	private load(): QueueState {
		const fallback = defaultState(this.now());
		if (!this.kv) return fallback;
		try {
			const raw = this.kv.getItem(this.key);
			if (!raw) return fallback;
			const parsed = JSON.parse(raw) as QueueState;
			if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.reports)) return fallback;
			this.state = {
				...fallback,
				...parsed,
				reports: parsed.reports.filter((report) => !!report && typeof report.reportId === "string"),
				fingerprintCounts: parsed.fingerprintCounts ?? {},
				suppressed: parsed.suppressed ?? {},
			};
			this.rollover();
			this.dropExpired();
			this.trim();
			return this.state;
		} catch {
			return fallback;
		}
	}

	private rollover(): void {
		const key = dayKeyOf(this.now());
		if (this.state.dayKey === key) return;
		this.state.dayKey = key;
		this.state.dayCount = 0;
		for (const fp of Object.keys(this.state.fingerprintCounts)) {
			this.state.fingerprintCounts[fp].day = 0;
		}
		this.state.networkWindowStart = 0;
		this.state.networkCount = 0;
	}

	private dropExpired(): void {
		const cutoff = this.now() - RETENTION_MS;
		const kept = this.state.reports.filter((report) => report.createdAtMs >= cutoff);
		if (kept.length !== this.state.reports.length) this.state.reports = kept;
	}

	private trim(): void {
		while (this.state.reports.length > QUEUE_LIMIT) this.state.reports.shift();
		while (this.state.reports.length > 0 && this.serializedSize() > QUEUE_MAX_BYTES) {
			this.state.reports.shift();
		}
	}

	private serializedSize(): number {
		try {
			return JSON.stringify(this.state).length;
		} catch {
			return 0;
		}
	}

	private persist(): void {
		if (!this.kv) return;
		try {
			this.kv.setItem(this.key, JSON.stringify(this.state));
		} catch {
			// localStorage 配额/禁用：只保留内存队列，不影响主流程
		}
	}

	private bumpSuppressed(fingerprint: string): void {
		this.state.suppressed[fingerprint] = (this.state.suppressed[fingerprint] ?? 0) + 1;
	}

	/** 入队；被配额/采样/去重抑制时返回 null（抑制次数会累加到下一次同指纹记录）。 */
	enqueue(input: EnqueueInput): QueuedReport | null {
		const now = this.now();
		this.rollover();
		this.dropExpired();

		const normalized = normalizeMessage(input.message);
		const fingerprint = clientFingerprint(
			input.phase,
			input.errorName,
			input.code,
			input.httpStatus,
			normalized,
			fnv1aHex,
		);

		// 同一指纹 10 分钟内重复：只累加计数，不再产生新条目。
		// 取队列中最近的一条同指纹记录比较（采样后可能同时存在多条），避免用最旧那条导致重复入库。
		let existing: QueuedReport | undefined;
		for (let i = this.state.reports.length - 1; i >= 0; i--) {
			if (this.state.reports[i].clientFingerprint === fingerprint) {
				existing = this.state.reports[i];
				break;
			}
		}
		if (existing && now - existing.occurredAtMs < DEDUP_WINDOW_MS) {
			existing.suppressedCount++;
			return null;
		}

		const counts: FingerprintCount = this.state.fingerprintCounts[fingerprint] ?? {
			session: 0,
			day: 0,
			lastAt: 0,
		};
		counts.session++;
		counts.day++;
		counts.lastAt = now;
		this.state.fingerprintCounts[fingerprint] = counts;

		// 抑制计数属尽力而为：不在此同步落盘，避免错误风暴里每次抑制都写 localStorage；
		// 下一次真正入队或发送时会随状态一起持久化。
		if (counts.session > 3 && (counts.session - 3) % 10 !== 0) {
			this.bumpSuppressed(fingerprint);
			return null;
		}
		if (this.state.sessionCount >= SESSION_LIMIT || this.state.dayCount >= DAY_LIMIT) {
			this.bumpSuppressed(fingerprint);
			return null;
		}
		if (input.network) {
			if (this.state.networkWindowStart === 0 || now - this.state.networkWindowStart >= NETWORK_WINDOW_MS) {
				this.state.networkWindowStart = now;
				this.state.networkCount = 0;
			}
			if (this.state.networkCount >= NETWORK_LIMIT) {
				this.bumpSuppressed(fingerprint);
				return null;
			}
			this.state.networkCount++;
		}

		const suppressedCount = this.state.suppressed[fingerprint] ?? 0;
		delete this.state.suppressed[fingerprint];

		const report: QueuedReport = {
			reportId: newReportID(),
			clientFingerprint: fingerprint,
			occurredAtMs: now,
			level: input.level,
			phase: input.phase,
			errorName: input.errorName,
			message: input.message,
			code: input.code,
			httpStatus: input.httpStatus,
			stack: input.stack,
			contextJson: input.contextJson,
			deviceId: input.deviceId,
			pluginVersion: input.pluginVersion,
			platform: input.platform,
			os: input.os,
			signedIn: input.signedIn,
			vaultId: input.vaultId,
			suppressedCount,
			attempts: 0,
			nextAttemptAtMs: 0,
			createdAtMs: now,
		};
		this.state.reports.push(report);
		this.state.sessionCount++;
		this.state.dayCount++;
		this.trim();
		this.persist();
		return report;
	}

	/** 到期待发条目（按入队顺序）。 */
	pending(now: number = this.now()): QueuedReport[] {
		this.dropExpired();
		return this.state.reports.filter((report) => report.nextAttemptAtMs <= now);
	}

	markSent(reportIDs: string[]): void {
		const ids = new Set(reportIDs);
		this.state.reports = this.state.reports.filter((report) => !ids.has(report.reportId));
		this.persist();
	}

	markFailed(reportIDs: string[], retryAfterMs: number): void {
		const now = this.now();
		const ids = new Set(reportIDs);
		for (const report of this.state.reports) {
			if (!ids.has(report.reportId)) continue;
			report.attempts++;
			const backoff = BACKOFF_MS[Math.min(report.attempts - 1, BACKOFF_MS.length - 1)];
			report.nextAttemptAtMs = now + (retryAfterMs > 0 ? retryAfterMs : backoff);
		}
		this.persist();
	}

	/** 开关关闭时清空内存与 localStorage。 */
	clear(): void {
		this.state = defaultState(this.now());
		if (!this.kv) return;
		try {
			this.kv.removeItem(this.key);
		} catch {
			// 忽略
		}
	}

	size(): number {
		return this.state.reports.length;
	}

	/** 仅测试使用：读取内部状态快照。 */
	snapshot(): QueueState {
		return this.state;
	}
}

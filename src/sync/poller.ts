// Head Poller（spec §10）：远端变化的唯一发现方式是轮询 GetVaultHead。
// - 轮询 tick 只能请求 Head 和调度 Session，不能调用 vault.getFiles()、adapter.stat 或内容 hash
// - Head 改变只触发完整 Remote Manifest 下载，不设置 force_audit（spec §4 不变量 11）
// - 轮询基准间隔默认 20s（桌面构建期注入，test/prod 20s、local 3s；移动 20s），收到 GetVaultHead
//   下发的 sync_interval_ms 后以其为准，±10% 随机抖动；连续失败指数退避，最大 5 分钟
// - 后台（visibilityState != visible）停止发起新 Session
// - 轮询定时器与完整审计定时器分离：低频完整审计（默认 6h）由独立 timer 驱动

import { Platform } from "obsidian";

import { debugLog } from "../debug-log";
import { isUnauthenticated } from "../remote-connect";
import { ReconcileSession } from "./session";
import type { SnapshotRemote } from "./remote";
import { backoffMs } from "./utils";

const POLL_INTERVAL = {
	desktop: Number(process.env.PICKPEN_DESKTOP_POLL_INTERVAL_MS ?? 20_000),
	mobile: 20_000,
};
export const FULL_AUDIT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 低频完整审计周期（§9.2）

export interface PollerDeps {
	remote: SnapshotRemote;
	session: ReconcileSession;
	/** 可轮询条件（token/vault 绑定/未暂停） */
	canPoll: () => boolean;
	/** 前台上次同步确认的 known Head（Base） */
	getKnownHead: () => { revision: bigint; rootHash: string } | null;
}

export class Poller {
	private readonly deps: PollerDeps;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private auditTimer: ReturnType<typeof setTimeout> | null = null;
	private failures = 0;
	private started = false;
	private visible = true;
	/** 服务端最近下发的同步轮询间隔（ms）；null = 尚未获取，用静态默认 */
	private serverIntervalMs: number | null = null;

	constructor(deps: PollerDeps) {
		this.deps = deps;
	}

	/** 启动定时器与前后台监听（插件 onLayoutReady 时调用） */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.visible = document.visibilityState === "visible";
		document.addEventListener("visibilitychange", this.onVisibilityChange);
		this.scheduleNext();
		this.scheduleAudit();
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		document.removeEventListener("visibilitychange", this.onVisibilityChange);
		if (this.pollTimer) clearTimeout(this.pollTimer);
		if (this.auditTimer) clearTimeout(this.auditTimer);
		this.pollTimer = null;
		this.auditTimer = null;
	}

	/** 切回前台：立即轮询 + 完整审计（§10 表格） */
	private onVisibilityChange = (): void => {
		this.visible = document.visibilityState === "visible";
		if (this.visible) {
			this.deps.session.requestRun({ forceAudit: true });
			void this.pollNow();
		}
	};

	/** 手动触发立即轮询（绑定/登录后） */
	pollNow(): Promise<void> {
		return this.tick();
	}

	private scheduleNext(): void {
		if (!this.started) return;
		if (this.pollTimer) clearTimeout(this.pollTimer);
		const base = this.serverIntervalMs ?? POLL_INTERVAL[Platform.isMobile ? "mobile" : "desktop"];
		const delay = Math.round(base * (0.9 + Math.random() * 0.2)); // ±10% 抖动
		this.pollTimer = setTimeout(() => {
			void this.tick().finally(() => this.scheduleNext());
		}, delay);
	}

	private scheduleAudit(): void {
		if (!this.started) return;
		if (this.auditTimer) clearTimeout(this.auditTimer);
		this.auditTimer = setTimeout(() => {
			// 前台空闲期间到达低频完整审计周期（§9.2 场景 5）
			if (document.visibilityState === "visible") {
				this.deps.session.requestRun({ forceAudit: true });
			}
			this.scheduleAudit();
		}, FULL_AUDIT_INTERVAL_MS);
	}

	/** 单次轮询 tick：只读 Head；变化 → 请求 Session（不设 force_audit） */
	private async tick(): Promise<void> {
		if (!this.deps.canPoll() || !this.visible) return;
		if (this.deps.session.isRunning()) return; // Session 运行中：由其结尾合并
		const known = this.deps.getKnownHead();
		debugLog.info(`[pickpen][HeadPoller] 轮询任务执行（knownRevision=${known?.revision ?? 0n}）`);
		try {
			const head = await this.deps.remote.pollHead(known?.revision ?? 0n, known?.rootHash ?? "");
			this.failures = 0;
			if (head) {
				// 服务端下发间隔：以其为后续轮询基准（值域为秒级，bigint→number 无精度损失）
				if (head.syncIntervalMs > 0n) this.serverIntervalMs = Number(head.syncIntervalMs);
				if (!head.unchanged) {
					this.deps.session.requestRun(); // Head 改变：触发对账，不触发本地全量扫描
				}
			}
		} catch (err) {
			if (isUnauthenticated(err)) {
				// 令牌失效：由 Session/登录状态机处理，退避到最大间隔
				this.failures = 3;
			} else {
				this.failures++;
				debugLog.warn(`[pickpen] 轮询失败（第 ${this.failures} 次）`, err);
			}
			// 失败退避：由 scheduleNext 的定时器继续；这里主动延迟下一 tick 起点
			await new Promise((r) => setTimeout(r, backoffMs(this.failures)));
		}
	}
}

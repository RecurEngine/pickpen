// 插件入口（Snapshot 同步 v2，spec §9/§10）：
// onload 装配（BaseStore/PendingStore/Session/Poller/LocalHint）
// → onLayoutReady：注册 vault 事件 → pending 检查 → 启动轮询 → requestRun({forceAudit:true})
// 启动、切回前台、定时轮询、本地 dirty hint 都只请求运行同一个串行 Session。

import { addIcon, Notice, Platform, Plugin, setIcon } from "obsidian";

import pickpenIconSvg from "./assets/pickpen.svg";
import { AuthManager } from "./auth";
import { debugLog } from "./debug-log";
import { reportSetupGuideShown } from "./event-report";
import { installHistoryFeature } from "./history-view";
import { planLegacyMigration, SessionStore, stripSessionKeys, vaultScopeKey, type KeyValueStore } from "./session-store";
import { RemoteClient } from "./remote-connect";
import { isSyncRibbonMenuItem, ribbonIcon, ribbonLabel, RIBBON_SYNC_TITLE, updateRibbonBadge } from "./ribbon-indicator";
import { PickpenSettingTab } from "./settings";
import { setupStage, SetupGuideModal, type SetupStage } from "./setup-guide";
import { localDateKey, StorageLimitModal } from "./storage-limit-alert";
import { syncState } from "./sync-state";
import { BASE_URL, DEBOUNCE_MS, DEFAULT_SETTINGS, resolveLocalDebounceMs, type PluginSettings } from "./types";
import { openVaultManager } from "./vault-manager";
import { BaseStore } from "./sync/base-store";
import { LocalHint } from "./sync/local-hint";
import { LocalSnapshotBuilder } from "./sync/local-snapshot";
import { PendingStore } from "./sync/pending-store";
import { Poller } from "./sync/poller";
import { SnapshotRemote } from "./sync/remote";
import { ReconcileSession } from "./sync/session";

const PICKPEN_ICON_ID = "pickpen-logo";
// addIcon 接收 SVG 内部节点；源文件保留完整 <svg>，便于独立预览与编辑。
const PICKPEN_ICON_SVG = pickpenIconSvg.replace(/^\s*<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

// createSessionStore 探测 localStorage 可用性；不可用（隐私模式/禁用站点存储）→ SessionStore 降级仅内存，
// 本次运行可登录但不跨重启，且会告警一次
function createSessionStore(scopeKey: string): SessionStore {
	let kv: KeyValueStore | null = null;
	try {
		kv = window.localStorage; // 与 KeyValueStore 接口同形；访问 getter 本身在禁用时抛错
	} catch {
		kv = null;
	}
	return new SessionStore(kv, scopeKey);
}

export default class PickpenPlugin extends Plugin {
	declare settings: PluginSettings;
	baseStore!: BaseStore;
	pendingStore!: PendingStore;
	session!: ReconcileSession;
	poller!: Poller;
	localHint!: LocalHint;
	client!: RemoteClient;
	remote!: SnapshotRemote;
	auth!: AuthManager;
	// sessionStore：设备本地登录会话（token 族/email/userId/deviceId），localStorage per-vault，
	// 不随 data.json 被 iCloud 同步；同步内核/UI 经内存镜像 settings 读取，此处仅做存取收口
	sessionStore!: SessionStore;
	private ribbonEl?: HTMLElement;
	private storageLimitModal: StorageLimitModal | null = null;
	private guideModal: SetupGuideModal | null = null;
	private settingTab!: PickpenSettingTab;
	// accountBinding 本次会话的绑定记忆（账号 + vault_id）：登录后判定「同账号重登沿用绑定」vs「走选择流程」
	private accountBinding: { email: string; vaultId: string } | null = null;
	private localBuilder!: LocalSnapshotBuilder;

	async onload(): Promise<void> {
		// 模块可能在 Obsidian 内热重载：未收到新 Head 前始终从客户端默认防抖值开始。
		syncState.localDebounceMs = DEBOUNCE_MS;
		// 品牌图标：P 字母轮廓叠加书写笔，使用 currentColor 自动跟随 Obsidian 主题。
		addIcon(PICKPEN_ICON_ID, PICKPEN_ICON_SVG);

		// —— 登录会话装配：设备本地 localStorage 为权威，data.json 只存绑定/偏好 ——
		this.sessionStore = createSessionStore(vaultScopeKey(this.app));
		this.sessionStore.load();
		syncState.update({ storageLimitExceeded: this.sessionStore.storageLimitAlertActive });

		// 历史残留字段剥离（baseUrl/debounceMs/username/token/expiresAtMs）
		const loaded = (await this.loadData()) ?? {};
		delete loaded.baseUrl;
		delete loaded.debounceMs;
		delete loaded.username;
		delete loaded.token;
		delete loaded.expiresAtMs;

		// 迁移判定：data.json 若仍带会话（旧版本曾把会话写进 data.json，可能已被 iCloud 复制到多端）
		// → 老用户首迁：token 族导入设备本地，deviceId 强制重生成（旧值离线无法证明唯一，沿用会继续互顶）；
		// localStorage 已有会话 → 权威，data.json 残留会话键仅做剔除；全新 → 仅生成 deviceId
		const dataJsonHasSession = !!(loaded as Record<string, unknown>).accessToken;
		const action = planLegacyMigration(dataJsonHasSession, this.sessionStore.hasToken());
		if (action === "import") {
			const legacy = loaded as Partial<PluginSettings>;
			this.sessionStore.captureFrom({
				email: legacy.email ?? "",
				userId: legacy.userId ?? "",
				accessToken: legacy.accessToken ?? "",
				accessExpiresAtMs: legacy.accessExpiresAtMs ?? 0,
				refreshToken: legacy.refreshToken ?? "",
				refreshExpiresAtMs: legacy.refreshExpiresAtMs ?? 0,
				deviceId: "",
			});
		}
		this.sessionStore.ensureDeviceId(); // 全新/首迁都保证设备 ID 已生成（只存 localStorage）

		// data.json 仅保留非会话键合并进镜像；会话字段以 localStorage 权威覆盖
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stripSessionKeys(loaded));
		this.settings.persist = () => this.persistSettings();
		this.sessionStore.applyTo(this.settings);
		debugLog.setEnabled(this.settings.debugLog);
		// 迁移/残留会话键 → 剔除后重写 data.json（防 iCloud 晚到副本把会话键回灌文件）
		if (action !== "fresh") {
			await this.persistSettings();
		}

		// 绑定归属（vaultId + 绑定时账号邮箱）随 data.json 共享：新设备登录同账号可自动沿用原绑定。
		// 旧版本把 owner 存设备本地 localStorage → 一次性迁入 settings（data.json）并清除本地副本
		if (!this.settings.vaultOwner && this.sessionStore.vaultOwner) {
			this.settings.vaultOwner = this.sessionStore.vaultOwner;
			this.sessionStore.clearVaultOwner();
		}

		// 跨账号守卫：data.json 的 vaultId 若来自别的账号（iCloud 推来旧绑定）且归属账号与当前会话不符 → 解绑待重选。
		// owner 缺失（老版本未记录）时不拦截，交给登录后 afterLogin 的引导
		const owner = this.settings.vaultOwner;
		if (owner && this.settings.vaultId && (owner.vaultId !== this.settings.vaultId || owner.email !== this.settings.email)) {
			this.settings.vaultId = "";
			this.settings.vaultName = "";
			delete this.settings.vaultOwner;
			await this.persistSettings();
			debugLog.warn("[pickpen] data.json 绑定仓库归属其他账号，已解绑，请重新选择要绑定的仓库");
		}

		this.accountBinding = this.settings.accessToken && this.settings.vaultId
			? { email: this.settings.email, vaultId: this.settings.vaultId }
			: null;

		// Base Snapshot Store：device/schema/vault 校验，损坏 → 安全 Bootstrap（spec §6.4）
		this.baseStore = new BaseStore(this, this.settings.deviceId);
		this.pendingStore = new PendingStore(this);
		this.localBuilder = new LocalSnapshotBuilder();

		// 远端客户端与 Snapshot Fetcher（auth 在 client 之后装配，getConfig 闭包延迟求值）
		this.client = new RemoteClient(() => ({
			baseUrl: BASE_URL,
			pluginVersion: this.manifest.version,
			accessToken: this.settings.accessToken,
			accessExpiresAtMs: this.settings.accessExpiresAtMs,
			vaultId: this.settings.vaultId,
			onUnauthenticated: () => this.auth?.refresh() ?? Promise.resolve(false),
		}));
		this.client.rebuild(BASE_URL);
		// auth 会话写入漏斗：改完内存镜像 → captureFrom 落设备本地 localStorage
		this.auth = new AuthManager(this.settings, this.client, () => this.sessionStore.captureFrom(this.settings));
		this.remote = new SnapshotRemote(
			this.client,
			() => ({
				baseUrl: BASE_URL,
				accessToken: this.settings.accessToken,
				vaultId: this.settings.vaultId,
			}),
			(head) => {
				const localDebounceMs = resolveLocalDebounceMs(head.localDebounceMs);
				if (localDebounceMs !== syncState.localDebounceMs) syncState.update({ localDebounceMs });
			},
		);

		// 串行 Reconcile Session（唯一入口）
		this.session = new ReconcileSession({
			app: this.app,
			getSettings: () => this.settings,
			baseStore: this.baseStore,
			pendingStore: this.pendingStore,
			localBuilder: this.localBuilder,
			remote: this.remote,
			pluginDir: this.manifest.dir ?? "",
			caseInsensitive: Platform.isMobileApp, // 移动端文件系统按大小写不敏感处理
			initialStorageLimitExceeded: this.sessionStore.storageLimitAlertActive,
			onStatus: (s) => {
				syncState.update({
					sessionRunning: s.running,
					lastError: s.lastError,
					blockedPaths: s.blockedPaths,
					storageLimitExceeded: s.storageLimitExceeded,
				});
				this.handleStorageLimitState(s.storageLimitExceeded, s.storageLimitConfirmed);
			},
		});
		this.localHint = new LocalHint(
			this.app.vault,
			this.session,
			() => syncState.localDebounceMs,
			(ref) => this.registerEvent(ref),
		);
		this.poller = new Poller({
			remote: this.remote,
			session: this.session,
			canPoll: () => !!this.settings.accessToken && !!this.settings.vaultId && !syncState.pausedReason,
			getKnownHead: () => {
				const base = this.baseStore.getBase();
				if (!base) return null;
				return { revision: BigInt(base.base_revision), rootHash: base.base_root_hash };
			},
		});

		// 已登录但未绑定（异常态兜底）→ 暂停，等待用户在仓库管理中选择
		if (this.settings.accessToken && !this.settings.vaultId) {
			this.pauseSync("请选择要绑定的仓库");
		}

		this.settingTab = new PickpenSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// ribbon 图标：同步状态提示；点击立即同步
		this.ribbonEl = this.addRibbonIcon("refresh-cw", RIBBON_SYNC_TITLE, () => {
			if (syncState.storageLimitExceeded) {
				this.showStorageLimitAlert(true);
				return;
			}
			void this.syncNow();
		});
		this.addRibbonIcon(PICKPEN_ICON_ID, "Pickpen Sync 设置", () => {
			this.settingTab.openInSystemSettings();
		});
		syncState.onChange(() => this.updateRibbon());
		if (Platform.isMobile) this.installMobileRibbonObserver();
		this.updateRibbon();

		// 命令：立即同步
		this.addCommand({
			id: "sync-now",
			name: "立即同步",
			callback: () => {
				void this.syncNow();
			},
		});

		// 文件历史版本：右键菜单「拾笔版本历史」+ 命令面板入口（spec FR-16）
		installHistoryFeature(this);

		this.updateDebugHook();

		// 启动时序：全部挂在 onLayoutReady 内
		this.app.workspace.onLayoutReady(() => {
			void this.onLayoutReady();
		});

		debugLog.info("[pickpen] Pickpen Sync 插件已加载");
	}

	private async onLayoutReady(): Promise<void> {
		// ① Base 与 pending 加载（pending 存在 → 第一个 Session 先走恢复，spec §9.4）
		const loadResult = await this.baseStore.load();
		await this.pendingStore.load();
		// ② 注册 vault 事件（只维护 dirty_paths + requestRun，spec §5）
		this.localHint.register();
		// ③ 启动 Head 轮询与低频完整审计定时器（分离，spec §10）
		this.poller.start();
		// ④ 启动场景：force_audit（spec §9.2 场景 1；loadResult 异常同样是完整审计场景）
		const forceAudit = loadResult !== "ok" || this.pendingStore.getPending() !== null;
		this.session.requestRun({ forceAudit: true });
		void forceAudit;
		debugLog.info("[pickpen] 启动时序完成：Base 加载 + 事件注册 + 轮询 + Session");
	}

	// onUserEnable 用户点击启用插件那一刻（冷启动不会触发）：布局就绪后给出一次性引导。
	// 不落任何持久化标记——该回调本身就是「用户此刻明确启用了插件」的信号。
	onUserEnable(): void {
		this.app.workspace.onLayoutReady(() => this.maybeShowSetupGuide());
	}

	// maybeShowSetupGuide 引导入口：仅在配置未完成（未登录 / 未绑定仓库）时提示
	private maybeShowSetupGuide(): void {
		const stage = setupStage(this.settings);
		if (stage) this.showSetupGuide(stage);
	}

	// showSetupGuide 弹出引导弹窗；已有其他弹窗时不叠加
	private showSetupGuide(stage: SetupStage): void {
		if (this.guideModal || this.storageLimitModal) return;
		const modal = new SetupGuideModal(this.app, stage, {
			onPrimary: () => {
				if (stage === "bind") {
					modal.close();
					openVaultManager(this.app, this);
					return;
				}
				// 打开设置失败（宿主缺少设置接口）时保留弹窗：降级提示已给出，用户仍可选「稍后」
				if (this.settingTab.openInSystemSettings({ focus: "account" })) modal.close();
			},
			onClosed: () => {
				this.guideModal = null;
			},
		});
		this.guideModal = modal;
		modal.open();
		// 上报放在去重守卫与 open() 之后：统计的是「真的展示给用户」的次数
		reportSetupGuideShown(this.client, stage);
	}

	// syncNow 立即同步（命令面板 / ribbon）；未完成配置时改为把用户送到对应入口，不留死胡同
	private async syncNow(): Promise<void> {
		const stage = setupStage(this.settings);
		if (stage === "login") {
			new Notice("请先登录并绑定仓库");
			this.settingTab.openInSystemSettings({ focus: "account" });
			return;
		}
		if (stage === "bind") {
			new Notice("请先选择要绑定的仓库");
			openVaultManager(this.app, this);
			return;
		}
		this.session.requestRun();
	}

	private updateRibbon(): void {
		if (!this.ribbonEl) return;
		const storageLimitExceeded = syncState.storageLimitExceeded;
		const label = ribbonLabel({
			stage: setupStage(this.settings),
			storageLimitExceeded,
			pausedReason: syncState.pausedReason,
			lastError: syncState.lastError,
			blockedCount: syncState.blockedPaths.length,
			lastSyncAt: syncState.lastSyncAt,
			allSynced: syncState.allSynced,
		});
		this.ribbonEl.setAttribute("aria-label", label);
		this.ribbonEl.setAttribute("title", label);
		const icon = ribbonIcon(storageLimitExceeded);
		if (this.ribbonEl.dataset.pickpenIcon !== icon) {
			setIcon(this.ribbonEl, icon);
			this.ribbonEl.dataset.pickpenIcon = icon;
		}
		updateRibbonBadge(this.ribbonEl, storageLimitExceeded);
		this.ribbonEl.classList.toggle("pickpen-ribbon-storage-full", storageLimitExceeded);
		if (Platform.isMobile) this.updateMobileRibbonMenu(storageLimitExceeded);
	}

	/**
	 * Obsidian 移动端不会显示 addRibbonIcon 返回的节点，而是在底部抽屉中按初始配置
	 * 动态生成 menu-item。监听菜单创建并把当前容量状态同步到真正可见的图标节点。
	 */
	private installMobileRibbonObserver(): void {
		const observer = new MutationObserver((mutations) => {
			const menuItems = new Set<HTMLElement>();
			for (const mutation of mutations) {
				for (const added of mutation.addedNodes) {
					if (!(added instanceof HTMLElement)) continue;
					const containingItem = added.matches(".menu-item")
						? added
						: added.closest<HTMLElement>(".menu-item");
					if (containingItem) menuItems.add(containingItem);
					for (const item of added.querySelectorAll<HTMLElement>(".menu-item")) menuItems.add(item);
				}
			}
			this.updateMobileRibbonMenu(syncState.storageLimitExceeded, menuItems);
		});
		observer.observe(document.body, { childList: true, subtree: true });
		this.register(() => observer.disconnect());
	}

	private updateMobileRibbonMenu(
		storageLimitExceeded: boolean,
		items: Iterable<HTMLElement> = document.querySelectorAll<HTMLElement>(".menu-item"),
	): void {
		for (const item of items) {
			if (!isSyncRibbonMenuItem(item)) continue;
			const iconEl = item.querySelector<HTMLElement>(".menu-item-icon");
			if (!iconEl) continue;
			const icon = ribbonIcon(storageLimitExceeded);
			if (iconEl.dataset.pickpenIcon !== icon) {
				setIcon(iconEl, icon);
				iconEl.dataset.pickpenIcon = icon;
			}
			updateRibbonBadge(iconEl, storageLimitExceeded);
			item.classList.toggle("pickpen-mobile-ribbon-storage-full", storageLimitExceeded);
		}
	}

	private handleStorageLimitState(exceeded: boolean, confirmed: boolean): void {
		if (!exceeded) {
			this.storageLimitModal?.close();
			this.sessionStore.clearStorageLimitAlert();
			return;
		}
		if (confirmed) this.showStorageLimitAlert(false);
	}

	private showStorageLimitAlert(force: boolean): void {
		if (!syncState.storageLimitExceeded || this.storageLimitModal) return;
		if (!force && this.guideModal) return; // 引导弹窗在前：不叠加第二个弹窗
		const today = localDateKey();
		if (!force && this.sessionStore.storageLimitAlertDate === today) return;
		this.sessionStore.markStorageLimitAlertShown(today);
		this.storageLimitModal = new StorageLimitModal(
			this,
			() => this.settingTab.openInSystemSettings({ focus: "subscription" }),
			() => {
				this.storageLimitModal = null;
			},
		);
		this.storageLimitModal.open();
	}

	// persistSettings 落盘 data.json：剔除会话键（token/email/userId/deviceId 只存设备本地 localStorage）
	private async persistSettings(): Promise<void> {
		await this.saveData(stripSessionKeys(this.settings));
	}

	async saveSettings(): Promise<void> {
		await this.persistSettings();
	}

	/** 调试开关变更时同步私有日志与只读诊断入口。 */
	setDebugEnabled(enabled: boolean): void {
		debugLog.setEnabled(enabled);
		this.updateDebugHook();
	}

	private updateDebugHook(): void {
		const host = window as unknown as Record<string, unknown>;
		if (!this.settings.debugLog) {
			delete host.__pickpenDebug;
			return;
		}
		host.__pickpenDebug = {
			snapshot: () => {
				const base = this.baseStore?.getBase();
				return {
					pluginVersion: this.manifest.version,
					environment: process.env.PICKPEN_ENV ?? "test",
					signedIn: !!this.settings.accessToken,
					vaultBound: !!this.settings.vaultId,
					sync: {
						running: syncState.sessionRunning,
						paused: !!syncState.pausedReason,
						pendingCount: syncState.pendingCount,
						blockedCount: syncState.blockedPaths.length,
						lastSyncAt: syncState.lastSyncAt,
					},
					base: base
						? { revision: base.base_revision, entryCount: Object.keys(base.entries).length }
						: null,
					pendingRecovery: this.pendingStore?.getPending() !== null,
				};
			},
			requestSync: () => this.session?.requestRun({ forceAudit: true }),
		};
	}

	/** 暂停同步（登录失效/未绑定/仓库管理操作中） */
	pauseSync(reason: string): void {
		debugLog.info(`[pickpen] 暂停同步：${reason}`);
		syncState.update({ pausedReason: reason });
	}

	/** 恢复同步 */
	resumeSync(): void {
		debugLog.info("[pickpen] 恢复同步");
		syncState.update({ pausedReason: "" });
	}

	// afterLogin 登录成功后的绑定决策（状态机核心，settings.ts 登录按钮调用）：
	// 同账号重登（token 过期续登）→ 沿用原绑定零打扰；否则暂停同步并打开仓库管理
	async afterLogin(onBindingChange?: () => void): Promise<void> {
		const { email, vaultId } = this.settings;
		const bound = this.accountBinding;
		// 沿用条件：①本会话曾绑定同账号同仓库；或 ②data.json 共享的绑定归属属于当前账号（新设备免重选）
		const owner = this.settings.vaultOwner;
		const adopt = owner !== undefined && owner.vaultId === vaultId && owner.email === email;
		const known = bound?.email === email && bound.vaultId === vaultId;
		if (vaultId && (adopt || known)) {
			if (adopt) this.accountBinding = { email, vaultId }; // 采纳归属，同步本次会话记忆
			this.resumeSync();
			new Notice("登录成功");
			void this.poller.pollNow();
			return;
		}
		this.pauseSync("请选择要绑定的仓库");
		new Notice("登录成功，请选择要绑定的仓库");
		openVaultManager(this.app, this, onBindingChange); // 绑定完成后重绘发起登录的设置视图
	}

	// bindVault 绑定仓库（仓库管理回调）：换绑判定按 vault_id（spec §6.4，名字仅展示）；
	// 换绑时旧 Base/pending 对新仓库无效甚至有害，必须重置
	async bindVault(vaultId: string, name: string): Promise<void> {
		const prev = this.accountBinding;
		const changed = !prev || prev.email !== this.settings.email || prev.vaultId !== vaultId;
		this.settings.vaultId = vaultId;
		this.settings.vaultName = name;
		if (changed) {
			syncState.update({ storageLimitExceeded: false });
			this.handleStorageLimitState(false, false);
			this.baseStore.reset();
			await this.baseStore.flush();
			await this.pendingStore.clear();
			this.session.reset();
		}
		this.accountBinding = { email: this.settings.email, vaultId };
		this.settings.vaultOwner = { vaultId, email: this.settings.email }; // 归属随 data.json 共享，供新设备沿用/跨账号守卫
		await this.saveSettings();
		debugLog.info("[pickpen] 已绑定仓库");
		this.resumeSync();
		new Notice(`已绑定仓库：${name}`);
		this.session.requestRun({ forceAudit: true });
	}

	// renameBoundVault 当前绑定仓库被重命名（仓库管理回调）：本地绑定跟随新名；
	// vault_id 不变、Blob 按 hash 寻址，Base/pending 无需重置
	async renameBoundVault(newName: string): Promise<void> {
		this.settings.vaultName = newName;
		await this.saveSettings();
		new Notice(`仓库已重命名：${newName}`);
	}

	// deleteBoundVault 当前绑定仓库被删除（仓库管理回调）：解绑回未绑定状态
	async deleteBoundVault(): Promise<void> {
		this.settings.vaultId = "";
		this.settings.vaultName = "";
		this.accountBinding = null;
		delete this.settings.vaultOwner;
		await this.saveSettings();
		this.pauseSync("请选择要绑定的仓库");
		new Notice("原仓库已删除，请重新选择要绑定的仓库");
	}

	// logout 退出登录 = 解绑：清 token 与绑定仓库（重新登录必须重新选择）
	async logout(): Promise<void> {
		this.accountBinding = null;
		syncState.update({ storageLimitExceeded: false });
		this.handleStorageLimitState(false, false);
		this.pauseSync("未登录");
		await this.auth.logout(); // 清 token 会话（写设备本地 localStorage，保留 email/deviceId）
		this.settings.vaultId = "";
		this.settings.vaultName = "";
		delete this.settings.vaultOwner;
		await this.saveSettings();
	}

	async onunload(): Promise<void> {
		delete (window as unknown as Record<string, unknown>).__pickpenDebug;
		this.poller.stop();
		this.localHint.unload();
		await this.baseStore.flush();
		debugLog.info("[pickpen] Pickpen Sync 插件已卸载");
		debugLog.setEnabled(false);
	}
}

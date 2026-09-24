// 插件入口（Snapshot 同步 v2，spec §9/§10）：
// onload 装配（BaseStore/PendingStore/Session/Poller/LocalHint）
// → onLayoutReady：注册 vault 事件 → pending 检查 → 启动轮询 → requestRun({forceAudit:true})
// 启动、切回前台、定时轮询、本地 dirty hint 都只请求运行同一个串行 Session。

import { addIcon, Notice, Platform, Plugin, setIcon, setTooltip, TFile } from "obsidian";

import pickpenIconSvg from "./assets/pickpen.svg";
import { AuthManager } from "./auth";
import { requestPassword } from "./crypto/password-modal";
import { resolveAutoUnlockPrompt, unlockPromptKey, type UnlockPromptCopy } from "./crypto/unlock-prompt";
import { createVaultKey, unwrapDek, wrapDekWithPassword, WrongPasswordError } from "./crypto/vault-crypto";
import { vaultKeys } from "./crypto/vault-key-store";
import { debugLog } from "./debug-log";
import { installDeletedFilesFeature } from "./deleted-files-view";
import { installHistoryFeature } from "./history-view";
import { planLegacyMigration, SessionStore, stripSessionKeys, vaultScopeKey, type KeyValueStore } from "./session-store";
import { RemoteClient } from "./remote-connect";
import { isSyncRibbonMenuItem, ribbonIcon, ribbonLabel, RIBBON_SYNC_TITLE, updateRibbonBadge } from "./ribbon-indicator";
import { PickpenSettingTab } from "./settings";
import { setupStage, SetupGuideModal, type SetupStage } from "./setup-guide";
import { localDateKey, StorageLimitModal } from "./storage-limit-alert";
import { syncResultMessage } from "./sync-result";
import { syncState } from "./sync-state";
import { BASE_URL, DEBOUNCE_MS, DEFAULT_SETTINGS, resolveLocalDebounceMs, type PluginSettings, type VaultInfo } from "./types";
import { createRemoteVault, enableRemoteVaultEncryption, fetchVaults, openVaultManager, updateRemoteVaultKey } from "./vault-manager";
import { BaseStore } from "./sync/base-store";
import { LocalHint } from "./sync/local-hint";
import { LocalSnapshotBuilder } from "./sync/local-snapshot";
import { PendingStore } from "./sync/pending-store";
import { Poller } from "./sync/poller";
import { SnapshotRemote } from "./sync/remote";
import { normalizeSelectiveSettings } from "./sync/selective";
import { ReconcileSession } from "./sync/session";

// PAUSED_BY_LOCK 加密仓库未解锁时的暂停原因（同步状态栏展示；解锁后自动恢复）
export const PAUSED_BY_LOCK = "仓库已加密，请输入密码解锁";

const PICKPEN_ICON_ID = "pickpen-logo";
// addIcon 接收 SVG 内部节点；源文件保留完整 <svg>，便于独立预览与编辑。
const PICKPEN_ICON_SVG = pickpenIconSvg.replace(/^\s*<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

// 启动提醒延迟：等工作区与 ribbon 渲染完再提示，避免与宿主启动界面、其他插件通知抢注意力
const STARTUP_REMINDER_DELAY_MS = 1500;

// LegacyDataJson：data.json 的读取视图——正常设置字段（Partial<PluginSettings>）
// 叠加历史残留字段（旧版本写入、现已不再使用，读取时一律剥离）。
interface LegacyDataJson extends Partial<PluginSettings> {
	baseUrl?: unknown;
	debounceMs?: unknown;
	username?: unknown;
	token?: unknown;
	expiresAtMs?: unknown;
	extraExcludes?: unknown;
}

// createLocalKV 探测 localStorage 可用性；不可用（隐私模式/禁用站点存储）→ 调用方降级为仅内存，
// 本次运行可登录但不跨重启，且会告警一次
function createLocalKV(): KeyValueStore | null {
	try {
		return window.localStorage; // 与 KeyValueStore 接口同形；访问 getter 本身在禁用时抛错
	} catch {
		return null;
	}
}

function createSessionStore(scopeKey: string): SessionStore {
	return new SessionStore(createLocalKV(), scopeKey);
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
	// startupReminderTimer 启动提醒定时器；setupGuideShown 本会话是否已展示过引导弹窗
	private startupReminderTimer: number | null = null;
	private setupGuideShown = false;
	/** 已卸载：在途的异步收尾（如手动同步回执）不再打扰用户 */
	private unloaded = false;
	private settingTab!: PickpenSettingTab;
	// accountBinding 本次会话的绑定记忆（账号 + vault_id）：登录后判定「同账号重登沿用绑定」vs「走选择流程」
	private accountBinding: { email: string; vaultId: string } | null = null;
	private localBuilder!: LocalSnapshotBuilder;
	// promptedUnlockKey 已自动弹过解锁窗的「仓库:密钥版本」；用户取消后不再重复，密钥再变才重新提示
	private promptedUnlockKey = "";
	// localKeyOp 本机正在执行的密钥操作计数（新建加密仓库/转换/改密码）：期间不让在途 Head 触发自动弹窗
	private localKeyOp = 0;

	// Obsidian 的 onload 是同步接口（返回 void 值）：异步初始化整体收进 startup()，
	// 首个 await 之前的注册逻辑（图标、会话装配）仍在 onload 调用栈内同步完成，时序不变。
	onload(): void {
		void this.startup();
	}

	private async startup(): Promise<void> {
		// 模块可能在 Obsidian 内热重载：未收到新 Head 前始终从客户端默认防抖值开始。
		syncState.localDebounceMs = DEBOUNCE_MS;
		// 品牌图标：P 字母轮廓叠加书写笔，使用 currentColor 自动跟随 Obsidian 主题。
		addIcon(PICKPEN_ICON_ID, PICKPEN_ICON_SVG);

		// 仓库内容密钥的设备本地存储（「在本设备记住仓库密码」用），与会话同一作用域规则
		vaultKeys.configure(createLocalKV(), vaultScopeKey(this.app));

		// —— 登录会话装配：设备本地 localStorage 为权威，data.json 只存绑定/偏好 ——
		this.sessionStore = createSessionStore(vaultScopeKey(this.app));
		this.sessionStore.load();
		syncState.update({ storageLimitExceeded: this.sessionStore.storageLimitAlertActive });

		// 历史残留字段剥离（baseUrl/debounceMs/username/token/expiresAtMs/extraExcludes）
		// data.json 由本插件自身写入，读取时按「可能残留旧字段」的宽松结构声明：
		// 先落到 unknown 再断言，避免反序列化结果以 any 形式扩散到后续成员访问
		const raw: unknown = (await this.loadData()) ?? {};
		const loaded = raw as LegacyDataJson;
		delete loaded.baseUrl;
		delete loaded.debounceMs;
		delete loaded.username;
		delete loaded.token;
		delete loaded.expiresAtMs;
		// 旧「排除项追加」已下线（排除范围收敛为「需要排除的文件夹」）：老数据不迁移，直接剥掉
		delete loaded.extraExcludes;

		// 迁移判定：data.json 若仍带会话（旧版本曾把会话写进 data.json，可能已被 iCloud 复制到多端）
		// → 老用户首迁：token 族导入设备本地，deviceId 强制重生成（旧值离线无法证明唯一，沿用会继续互顶）；
		// localStorage 已有会话 → 权威，data.json 残留会话键仅做剔除；全新 → 仅生成 deviceId
		const dataJsonHasSession = !!loaded.accessToken;
		const action = planLegacyMigration(dataJsonHasSession, this.sessionStore.hasToken());
		if (action === "import") {
			const legacy = loaded;
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
		// 选择性同步是嵌套对象：Object.assign 只会带过 data.json 里的引用，缺键/脏值必须补齐，
		// 否则旧版本升级上来的实例里会出现 undefined 子项，把过滤规则判成「全部排除」
		this.settings.selective = normalizeSelectiveSettings(this.settings.selective);
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
		// auth 会话写入漏斗：改完内存镜像 → captureFrom 落设备本地 localStorage；
		// 读取回调用于刷新失败时判断本机记录是否已被另一个实例轮换（见 AuthManager.doRefresh）
		this.auth = new AuthManager(
			this.settings,
			this.client,
			() => this.sessionStore.captureFrom(this.settings),
			() => this.sessionStore.snapshot(),
		);
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
				void this.applyRemoteEncryptionState({
					// 用响应自带的仓库 ID，而不是投递时刻的绑定：换绑期间在途的旧仓库响应
					// 若被当成新仓库的状态，会用旧仓库的密钥版本顶掉新仓库的解锁态
					vaultId: head.vaultId,
					encrypted: head.encrypted,
					keyVersion: String(head.keyVersion),
				});
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
			pluginId: this.manifest.id,
			caseInsensitive: Platform.isMobileApp, // 移动端文件系统按大小写不敏感处理
			// 加密仓库未解锁时不能读盘算哈希：本轮整体不运行，并提示用户解锁
			preflight: (interactive) => this.ensureVaultUnlocked(interactive),
			initialStorageLimitExceeded: this.sessionStore.storageLimitAlertActive,
			notifyConfigReload: () => new Notice("配置已同步，重载 Obsidian 后生效"),
			onStatus: (s) => {
				syncState.update({
					sessionRunning: s.running,
					progress: s.progress,
					lastError: s.lastError,
					blockedPaths: s.blockedPaths,
					conflictCopyPaths: s.conflictCopyPaths,
					lastSyncAt: s.lastSyncAt,
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

		// 已删除的文件：命令面板入口 + 设置「同步」区 [查看]（specs/sync/spec.md 需求 3）
		installDeletedFilesFeature(this);

		this.updateDebugHook();

		// 启动时序：全部挂在 onLayoutReady 内
		this.app.workspace.onLayoutReady(() => {
			this.scheduleStartupSetupReminder(); // 每次启动都判定：配置未完成时延迟提醒
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
		// interactive：加密仓库会在启动时直接要求解锁，而不是静默停在暂停态
		const forceAudit = loadResult !== "ok" || this.pendingStore.getPending() !== null;
		this.session.requestRun({ forceAudit: true, interactive: true });
		void forceAudit;
		debugLog.info("[pickpen] 启动时序完成：Base 加载 + 事件注册 + 轮询 + Session");
	}

	// scheduleStartupSetupReminder 冷启动提醒：每次打开 Obsidian 都重新判定，配置未完成（未登录 /
	// 未绑定仓库）时提示，不落任何持久化标记。延迟到工作区渲染之后再弹，且到点才读取当前状态
	// ——延迟期间用户已登录 / 已绑定则静默跳过。
	private scheduleStartupSetupReminder(): void {
		this.startupReminderTimer = window.setTimeout(() => {
			this.startupReminderTimer = null;
			// 本会话已给过引导（例如「启用」那一刻刚弹过并被关掉）就不补弹第二次
			if (this.setupGuideShown) return;
			this.maybeShowSetupGuide();
		}, STARTUP_REMINDER_DELAY_MS);
		// 定时器不属于 Obsidian 生命周期：插件被禁用 / 更新后仍会触发，必须随卸载清掉
		this.register(() => this.clearStartupReminder());
	}

	// clearStartupReminder 清掉尚未触发的启动提醒
	private clearStartupReminder(): void {
		if (this.startupReminderTimer === null) return;
		window.clearTimeout(this.startupReminderTimer);
		this.startupReminderTimer = null;
	}

	// onUserEnable 用户点击启用插件那一刻（冷启动不会触发）：布局就绪后给出一次性引导。
	// 不落任何持久化标记——该回调本身就是「用户此刻明确启用了插件」的信号。
	// 冷启动时未完成配置由 scheduleStartupSetupReminder 提醒，两者重复触发由 showSetupGuide 去重。
	onUserEnable(): void {
		this.app.workspace.onLayoutReady(() => this.maybeShowSetupGuide());
	}

	// maybeShowSetupGuide 引导入口：仅在配置未完成（未登录 / 未绑定仓库）时提示
	private maybeShowSetupGuide(): void {
		const stage = setupStage(this.settings);
		if (stage) this.showSetupGuide(stage);
	}

	// showSetupGuide 弹出引导弹窗；已有其他弹窗时不叠加。
	// 会话标记与弹窗守卫各挡一类重复：守卫挡同时/重叠触发，标记挡「先弹的已被用户关掉、后弹的又来」
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
		this.setupGuideShown = true;
		modal.open();
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
		// 用户主动同步：加密仓库会先弹出解锁窗；同步结束时给一条结果回执。
		// 有内容变化 / 远端落地的轮次结束都会原子写 Base，所以 Base 根哈希变了就是「同步到了东西」。
		const beforeRoot = this.baseStore?.getBase()?.base_root_hash ?? "";
		const done = this.session.requestManualRun();
		if (!done) {
			new Notice("同步进行中…"); // 已有同步在跑：本次并入下一轮
			return;
		}
		await done;
		if (this.unloaded) return; // 卸载途中不再提示
		this.noticeSyncResult(
			syncResultMessage({
				pausedReason: syncState.pausedReason,
				lastError: syncState.lastError,
				storageLimitExceeded: syncState.storageLimitExceeded,
				blockedCount: syncState.blockedPaths.length,
				conflictCount: syncState.conflictCopyPaths.length,
				changed: (this.baseStore?.getBase()?.base_root_hash ?? "") !== beforeRoot,
			}),
		);
	}

	/**
	 * 同步结果回执。有冲突副本时在回执里附一个入口——副本是普通文件，
	 * 不给入口的话用户只能自己在文件列表里认出那个 `(conflict …)` 名字。
	 * v1 只跳第一个：处理入口不在这里，逐个打开即可。
	 */
	private noticeSyncResult(message: string): void {
		const conflicts = syncState.conflictCopyPaths;
		if (conflicts.length === 0) {
			new Notice(message);
			return;
		}
		let notice: Notice;
		const frag = createFragment((el) => {
			el.createDiv({ text: message });
			el.createEl("a", { cls: "pickpen-notice-link", text: "查看冲突副本", href: "#" }).addEventListener(
				"click",
				(evt) => {
					evt.preventDefault();
					notice.hide();
					this.openPath(conflicts[0]);
				},
			);
		});
		notice = new Notice(frag, 8000);
	}

	/** 在编辑区打开指定路径（冲突副本跳转用） */
	private openPath(path: string): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
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
			conflictCount: syncState.conflictCopyPaths.length,
			lastSyncAt: syncState.lastSyncAt,
			allSynced: syncState.allSynced,
		});
		// 提示只走 aria-label（Obsidian 自绘提示读它，与原生 Ribbon 按钮同款：右侧 + 300ms 延迟）。
		// 不要再写 title：那会额外弹出一个浏览器原生提示，鼠标悬停时两个提示叠在一起。
		setTooltip(this.ribbonEl, label, { placement: "right", delay: 300 });
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
					if (!added.instanceOf(HTMLElement)) continue;
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
					encryption: {
						boundVaultId: vaultKeys.boundVaultId,
						encrypted: vaultKeys.isEncrypted(),
						locked: vaultKeys.isLocked(),
						keyVersion: vaultKeys.keyVersion,
						hasKeyParams: !!vaultKeys.getParams(),
						remember: vaultKeys.remember,
					},
					base: base
						? { revision: base.base_revision, entryCount: Object.keys(base.entries).length }
						: null,
					pendingRecovery: this.pendingStore?.getPending() !== null,
				};
			},
			requestSync: () => this.session?.requestRun({ forceAudit: true, interactive: true }),
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

	// ===== 端到端加密仓库的密钥状态（spec §加密：仓库密码不上传，内容密钥随仓库元数据保存）=====


	/**
	 * 同步远端仓库的加密状态。密钥版本变化（别处转换了仓库或改过密码）时，
	 * 旧内容密钥与旧本地基线全部失效：必须重新取密钥参数、重建 Base，并让用户重新解锁。
	 * 未加密仓库直接同步执行，行为与改造前一致。
	 */
	async applyRemoteEncryptionState(state: {
		vaultId: string;
		encrypted: boolean;
		keyVersion: string;
	}): Promise<void> {
		// 在途的 Head 响应可能属于换绑前的旧仓库：按响应自带的仓库 ID 判别，不是当前绑定就丢弃
		if (!state.vaultId || state.vaultId !== this.settings.vaultId) return;
		const switched = vaultKeys.boundVaultId !== "" && vaultKeys.boundVaultId !== state.vaultId;
		// syncRemote 会改写加密态，先记下旧值：用于区分「对方刚启用加密」与「对方改了密码」
		const wasEncrypted = vaultKeys.isEncrypted();
		const keyChanged = vaultKeys.syncRemote(state);
		if (switched) {
			// 换绑：旧仓库的 Base/pending 对新仓库无效甚至有害
			this.baseStore.reset();
			await this.baseStore.flush();
			await this.pendingStore.clear();
			this.session.reset();
		} else if (keyChanged) {
			// 密钥代次可能变了（别处转换/新建），也可能只是重新包装（改密码）。
			// 这里不清空 Base：内容寻址是否失效由 Base 里记录的密钥代次判定——
			// 清空会让「内容没变、口径变了」的整库路径落进 Bootstrap 分支，复制出满仓冲突副本。
			// 但旧密钥下的 pending 不再可信，清掉并重新对账。
			await this.pendingStore.clear();
			if (this.session.isRunning()) this.session.requestRun({ forceAudit: true });
		}
		if (state.encrypted && vaultKeys.isLocked()) {
			// 首次拿到加密仓库状态时补一次参数；已取过则不重复请求。
			// 顺序不可颠倒：没有参数时 unlock 会直接报错，本机记忆也解不开
			if (!vaultKeys.getParams()) await this.adoptVaultState(state.vaultId);
			await vaultKeys.tryRestoreRemembered();
		}
		// 先落暂停态再弹窗：弹窗期间同步与轮询必须停住
		this.syncVaultLockState();
		this.autoPromptUnlock(switched, keyChanged, wasEncrypted);
	}

	/**
	 * 取到 Head 后才发现「仓库已加密、本机没有可用内容密钥」时主动弹解锁窗。
	 * 同一「仓库 + 密钥版本」只自动弹一次：Head 响应可能并发到达，用户取消后又会一直停在
	 * 未解锁态——没有去重就会反复弹窗；密钥版本再变则重新提示。换绑交给绑定流程处理。
	 */
	private autoPromptUnlock(switched: boolean, keyChanged: boolean, wasEncrypted: boolean): void {
		if (this.localKeyOp > 0) return; // 本机正在改密码/转换：变更由该流程自己处理
		const decision = resolveAutoUnlockPrompt({
			switched,
			locked: vaultKeys.isLocked(),
			keyChanged,
			wasEncrypted,
			vaultId: vaultKeys.boundVaultId,
			keyVersion: vaultKeys.keyVersion,
			promptedKey: this.promptedUnlockKey,
		});
		if (!decision) return;
		void this.promptUnlock(decision.copy); // 去重键的登记在 promptUnlock 内部完成
	}

	/** 纯取某仓库的加密状态与密钥参数（不改动运行时状态；核验非绑定仓库密码用） */
	private async fetchVaultInfo(vaultId: string): Promise<VaultInfo | undefined> {
		try {
			const vaults = await fetchVaults(this.client);
			return vaults.find((v) => v.vaultId === vaultId);
		} catch (err) {
			debugLog.warn(`[pickpen] 获取仓库加密参数失败：${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	/** 取参数并接管进运行时状态（只对当前绑定仓库生效） */
	private async adoptVaultState(vaultId: string): Promise<VaultInfo | undefined> {
		const info = await this.fetchVaultInfo(vaultId);
		if (!info || info.vaultId !== this.settings.vaultId) return info;
		vaultKeys.syncRemote({ vaultId: info.vaultId, encrypted: info.encrypted, keyVersion: info.keyVersion });
		vaultKeys.setParams(info.vaultId, info.keyParams);
		return info;
	}

	/** 把「是否未解锁」反映到同步状态（未解锁 = 暂停同步）。只管理自己这一条暂停原因，
	 * 不覆盖「未登录」「未绑定」「仓库管理操作中」等由其他流程设置的状态 */
	private syncVaultLockState(): void {
		if (!this.settings.vaultId) return;
		if (vaultKeys.isLocked()) {
			this.pauseSync(PAUSED_BY_LOCK);
			return;
		}
		if (syncState.pausedReason === PAUSED_BY_LOCK) this.resumeSync();
	}

	/**
	 * 确保绑定仓库已解锁。interactive=true 时弹窗要求输入密码（用户主动触发同步、绑定仓库时用）；
	 * 后台轮询一律用 false，避免反复弹窗打断编辑。
	 */
	async ensureVaultUnlocked(interactive: boolean): Promise<boolean> {
		if (!this.settings.vaultId) return true;
		// 冷启动首轮还不知道该仓库是否加密（Head 尚未返回）：先取一次状态再判断，
		// 否则会把加密仓库当成明文放行，随后整库扫描因缺少内容密钥全部落到 blocked
		if (!vaultKeys.boundVaultId) {
			const info = await this.adoptVaultState(this.settings.vaultId);
			if (info?.encrypted) await vaultKeys.tryRestoreRemembered();
		}
		if (!vaultKeys.isEncrypted()) return true;
		if (!vaultKeys.isLocked()) return true;
		if (!interactive) {
			this.syncVaultLockState();
			return false;
		}
		return this.promptUnlock();
	}

	/**
	 * 弹出解锁窗（启动、手动同步、绑定仓库等用户主动路径共用）。
	 * copy 用于按触发原因定制文案，见 autoPromptUnlock。
	 */
	async promptUnlock(copy?: UnlockPromptCopy): Promise<boolean> {
		if (!vaultKeys.isEncrypted()) {
			new Notice("当前仓库未启用端到端加密");
			return true;
		}
		if (!vaultKeys.isLocked()) {
			new Notice("仓库已解锁");
			return true;
		}
		// 登记本次提示：Head 响应可能并发到达，不登记会在弹窗还没关时又开一个。
		// 必须写在第一个 await 之前
		this.promptedUnlockKey = unlockPromptKey(this.settings.vaultId, vaultKeys.keyVersion);
		// 解锁前一律取一次最新参数：别处可能刚改过密码/转换过仓库，
		// 用旧参数解新信封只会一直报「密码不正确」，用户除了重启没有别的出路
		await this.adoptVaultState(this.settings.vaultId);
		const ok = await requestPassword(this.app, {
			title: copy?.title ?? "解锁仓库",
			description:
				copy?.description ?? "该仓库已启用端到端加密，请输入仓库密码解锁后继续同步。密码只在本地校验，不会上传。",
			submitLabel: "解锁",
			remember: { initial: vaultKeys.remember },
			onSubmit: async (password, remember) => {
				try {
					await vaultKeys.unlock(password);
				} catch (err) {
					if (err instanceof WrongPasswordError) return "仓库密码不正确";
					throw err;
				}
				// 解锁成功后才落定偏好：密码错误不留任何副作用（此刻密钥在手，开=落盘、关=清除）
				vaultKeys.setRemember(remember);
				this.syncVaultLockState();
				this.session.requestRun({ forceAudit: true });
				new Notice("仓库已解锁");
				return null;
			},
		});
		if (!ok) this.syncVaultLockState();
		return ok;
	}

	/** 在设置页切换「在本设备记住仓库密码」 */
	setRememberVaultPassword(enabled: boolean): void {
		vaultKeys.setRemember(enabled);
	}

	/** 新建仓库；password 非空 = 创建端到端加密仓库（就地生成内容密钥并接管解锁态） */
	async createVaultWithOptions(name: string, password: string | null): Promise<VaultInfo> {
		const params = password ? (await createVaultKey(password)).params : undefined;
		this.localKeyOp++; // 变更在途：不让 Head 响应把本机自己的操作当成「别处在改密钥」
		try {
			const info = await createRemoteVault(this.client, name, params);
			// 只在「当前没有绑定」或「建的就是当前绑定仓库」时接管密钥：
			// 否则在已绑定并解锁仓库 A 的情况下新建加密仓库 B，会把 A 的内容密钥顶掉，
			// 还在途的同步轮次会拿 B 的密钥去加密 A 的内容（本机与其它设备都将无法解密）
			const willOwnBinding = !this.settings.vaultId || this.settings.vaultId === info.vaultId;
			if (info.encrypted && password && willOwnBinding) await this.adoptVaultKey(info, password);
			return info;
		} finally {
			this.localKeyOp--;
		}
	}

	/**
	 * 接纳一个刚建立的加密仓库：接管密钥参数并解锁（口令刚由用户输入，无需再次询问）。
	 * 同时让本地基线作废——加密仓库的内容寻址与明文口径完全不同。
	 */
	private async adoptVaultKey(info: VaultInfo, password: string): Promise<void> {
		vaultKeys.syncRemote({ vaultId: info.vaultId, encrypted: true, keyVersion: info.keyVersion });
		vaultKeys.setParams(info.vaultId, info.keyParams);
		await vaultKeys.unlock(password);
	}

	/**
	 * 把未加密仓库转换为加密仓库：先登记加密参数，再用新口令生成内容密钥。
	 * 转换后本地全部内容以密文重新上传（一次全量提交）；转换前已产生的历史版本保持原样。
	 */
	async enableVaultEncryption(vaultId: string, password: string): Promise<void> {
		const { params } = await createVaultKey(password);
		this.localKeyOp++; // 变更在途：不让 Head 响应把本机自己的转换当成「别处在改密钥」
		try {
			const info = await enableRemoteVaultEncryption(this.client, vaultId, params);
			if (vaultId !== this.settings.vaultId) return;
			// 保留 Base 是关键：磁盘内容没变、远端也没变，只是寻址哈希换了口径。
			// 保留 Base 后三方对账会判定「仅 Local 改变」→ 全部走 put 重传，不会产生冲突副本；
			// 若清空 Base，同样一批路径会落进 Bootstrap 分支被判成「双方创建不同内容」，
			// 结果是每个文件都被复制成一份冲突副本。
			// 重算全部寻址哈希不靠一次性内存标志，而是由 Base 中记录的密钥代次驱动（见 session.runOnce）：
			// 这样转换中途失败/关闭 Obsidian，下次启动照样会重算，不会留下「声称已加密、内容仍是明文」的仓库。
			await this.pendingStore.clear();
			this.session.reset();
			await this.adoptVaultKey(info, password);
			this.syncVaultLockState();
			this.session.requestRun({ forceAudit: true, interactive: true });
		} finally {
			this.localKeyOp--;
		}
	}

	/** 用口令解开指定仓库的内容密钥（改密码前的核验；不改动运行时解锁态） */
	async verifyVaultPassword(vaultId: string, password: string): Promise<Uint8Array> {
		// 只取参数用于本地核验，绝不写回运行时状态：这是给别人仓库核验密码，
		// 顶掉当前绑定仓库的参数会让本仓库用正确密码也解不开
		const info = await this.fetchVaultInfo(vaultId);
		if (!info?.keyParams) throw new Error("仓库未启用端到端加密");
		return unwrapDek(password, info.keyParams);
	}

	/** 修改仓库密码：只重新包装同一个内容密钥，已存内容一个字节都不动 */
	async changeVaultPassword(vaultId: string, dek: Uint8Array, newPassword: string): Promise<void> {
		const params = await wrapDekWithPassword(dek, newPassword);
		this.localKeyOp++; // 变更在途：不让 Head 响应把本机自己的改密码当成「别处在改密钥」
		try {
			const info = await updateRemoteVaultKey(this.client, vaultId, params);
			if (vaultId !== this.settings.vaultId) return;
			// 内容密钥未变 → 本地基线仍然有效；用新参数重新装载以保持解锁态与记忆
			vaultKeys.syncRemote({ vaultId: info.vaultId, encrypted: true, keyVersion: info.keyVersion });
			vaultKeys.setParams(info.vaultId, info.keyParams);
			await vaultKeys.unlock(newPassword);
			this.syncVaultLockState();
		} finally {
			this.localKeyOp--;
		}
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
		// 加密仓库必须先解锁才能读盘算哈希：绑定是用户主动操作，直接弹解锁窗
		const info = await this.adoptVaultState(vaultId);
		if (info?.encrypted) {
			await vaultKeys.tryRestoreRemembered();
			if (vaultKeys.isLocked()) {
				this.syncVaultLockState();
				await this.promptUnlock();
				return;
			}
		}
		this.syncVaultLockState();
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
		vaultKeys.reset(); // 仓库已不存在，内容密钥与本地记忆一并清除
		delete this.settings.vaultOwner;
		await this.saveSettings();
		this.pauseSync("请选择要绑定的仓库");
		new Notice("原仓库已删除，请重新选择要绑定的仓库");
	}

	// logout 退出登录 = 解绑：清 token 与绑定仓库（重新登录必须重新选择）
	async logout(): Promise<void> {
		this.accountBinding = null;
		vaultKeys.reset(); // 解绑即上锁：内容密钥不跨账号留存
		syncState.update({ storageLimitExceeded: false });
		this.handleStorageLimitState(false, false);
		this.pauseSync("未登录");
		await this.auth.logout(); // 清 token 会话（写设备本地 localStorage，保留 email/deviceId）
		this.settings.vaultId = "";
		this.settings.vaultName = "";
		delete this.settings.vaultOwner;
		await this.saveSettings();
	}

	// 同 onload：onunload 也是同步接口，异步收尾收进 shutdown()，清理顺序与原先一致。
	onunload(): void {
		void this.shutdown();
	}

	private async shutdown(): Promise<void> {
		this.unloaded = true;
		delete (window as unknown as Record<string, unknown>).__pickpenDebug;
		// 卸载不会中断已启动的 Promise 链：必须显式停掉，否则旧实例会在「禁用→启用」
		// 或插件更新后与新实例并存——并发同步同一仓库，并继续消耗两边共享的 refresh token
		this.session?.dispose();
		this.auth?.dispose();
		this.poller.stop();
		this.localHint.unload();
		await this.baseStore.flush();
		debugLog.info("[pickpen] Pickpen Sync 插件已卸载");
		debugLog.setEnabled(false);
	}
}

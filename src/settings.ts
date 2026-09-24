// 设置面板（Snapshot 同步 v2）：账号登录、仓库绑定、同步范围（选择性同步）、已删除的文件入口与诊断。

import { App, ButtonComponent, Modal, Notice, Platform, PluginSettingTab, Setting, TFile, type SettingDefinitionGroup, type SettingDefinitionItem } from "obsidian";

import { renderAboutAndFeedback } from "./about";
import { copyText } from "./clipboard";
import { vaultKeys } from "./crypto/vault-key-store";
import { openDeletedFiles } from "./deleted-files-view";
import { debugLog, type DebugLevel, type DebugLogEntry } from "./debug-log";
import type PickpenPlugin from "./index";
import { renderInviteSection } from "./invite-view";
import { ErrCode, errorCode } from "./remote-connect";
import { openFolderExclusionManager } from "./selective-view";
import { AUDIO_EXTS, IMAGE_EXTS, PDF_EXTS, VIDEO_EXTS } from "./sync/selective";
import { formatProgress, progressPercent } from "./sync/progress";
import { StatusRefresh } from "./status-refresh";
import { syncState, type SyncState } from "./sync-state";
import { renderSubscriptionSection } from "./subscription-view";
import { renderMobileSubscriptionSection } from "./mobile-subscription-view";
import { BASE_URL, BUILD_TAG, type PluginSettings } from "./types";
import { openVaultManager } from "./vault-manager";

/** 跳转后需要滚动并高亮的区域 */
export type SettingsFocus = "account" | "subscription";

// 聚焦目标 → 容器选择器。账号区用专用 class 定位：.pickpen-settings-section 同时用于同步/诊断区。
const FOCUS_SELECTORS: Record<SettingsFocus, string> = {
	account: ".pickpen-account-section",
	subscription: ".pickpen-subscription-plans",
};

export function focusSelector(focus: SettingsFocus): string {
	return FOCUS_SELECTORS[focus];
}

// 聚焦请求有效期：宿主要为设置页新建窗口时会重绘一次，短暂保留请求以便重绘后补上高亮
const FOCUS_TTL_MS = 3000;

export class PickpenSettingTab extends PluginSettingTab {
	private readonly plugin: PickpenPlugin;
	private readonly view: PickpenSettingsView;
	private focusRequest: { target: SettingsFocus; expiresAt: number } | null = null;

	constructor(app: App, plugin: PickpenPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.view = new PickpenSettingsView(app, plugin);
	}

	/**
	 * 声明式设置：一个分区一个原生分组。分区标题由宿主渲染在分组卡片外（与系统设置页一致），
	 * 分区 UI 仍由原有渲染代码构建（render 回调），name/desc/aliases 供 Obsidian 1.13+ 的
	 * 设置搜索检索——分区内的具体设置项收敛成所属分区的关键词。
	 * 返回非空数组时 display() 不再被调用。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			this.sectionGroup("account", "账号和仓库", "登录、仓库绑定与端到端加密解锁状态", [
				"登录", "退出登录", "邮箱", "验证码", "注册", "邀请码", "绑定仓库", "仓库管理", "加密", "密码", "解锁",
			]),
			this.sectionGroup("sync", "同步", "文件类型、排除文件夹与配置文件同步", [
				"同步", "选择性同步", "同步图片", "同步音频", "同步视频", "同步 PDF", "其他类型", "排除文件夹", "排除",
				"同步配置文件", "主要设置", "外观", "主题", "CSS 片段", "快捷键", "核心插件", "第三方插件",
				"已删除的文件", "删除", "恢复",
			]),
			this.sectionGroup("invite", "邀请", "邀请码、邀请人数与邀请奖励进度", [
				"邀请码", "邀请人数", "邀请充值", "邀请用户",
			]),
			this.sectionGroup("subscription-status", "当前订阅", "当前套餐、容量与到期时间", [
				"订阅", "当前订阅", "当前档位", "套餐", "容量", "存储空间", "到期", "版本历史",
			]),
			this.sectionGroup("subscription-plans", "订阅方案", "可选套餐、价格与购买入口", [
				"订阅", "订阅方案", "套餐", "升级", "购买", "支付", "二维码", "价格", "折扣",
			]),
			this.sectionGroup("diagnostics", "诊断", "远端地址、设备 ID、构建环境与调试日志", [
				"诊断", "远端地址", "设备 ID", "构建环境", "插件版本", "调试日志", "日志",
			]),
			this.sectionGroup("about", "关于与反馈", "产品简介、反馈入口与相关链接", [
				"关于", "反馈", "版本", "隐私", "帮助",
			]),
		];
	}

	override hide(): void {
		this.view.dispose();
		super.hide();
	}

	/** 一个分区 = 一个原生分组：分组标题由宿主渲染，分组内一项承载该分区的自定义 UI */
	private sectionGroup(
		section: SettingsSection,
		heading: string,
		desc: string,
		aliases: string[],
	): SettingDefinitionGroup {
		return {
			type: "group",
			heading,
			items: [
				{
					// name/desc/aliases 只作设置搜索索引：render 会清空宿主渲染的信息区，标题由分组 heading 承担
					name: heading,
					desc,
					aliases,
					render: (setting) => {
						// 行元素会被宿主复用：样式类每次渲染都要重新声明
						setting.setClass("pickpen-declared-section");
						this.view.render(section, setting.settingEl);
						// 聚焦请求只可能落在账号区或订阅区：对应分区渲染完成后再高亮，
						// 其余分区渲染时不动，避免反复触发滚动
						if (this.focusOwner() === section) this.applyFocus();
						return () => this.view.disposeSection(section);
					},
				},
			],
		};
	}

	/** focusOwner 当前聚焦请求所属分区；无请求或目标不落在这两个分区时为 null */
	private focusOwner(): SettingsSection | null {
		const target = this.focusRequest?.target;
		if (target === "account") return "account";
		// 订阅的聚焦目标是「订阅方案」块（.pickpen-subscription-plans）
		if (target === "subscription") return "subscription-plans";
		return null;
	}

	/** 从 Ribbon、引导弹窗等入口打开 Obsidian 系统设置，选中 Pickpen Sync 并聚焦指定区域；返回是否成功打开。 */
	openInSystemSettings(options?: { focus?: SettingsFocus }): boolean {
		const focus = options?.focus;
		this.focusRequest = focus ? { target: focus, expiresAt: Date.now() + FOCUS_TTL_MS } : null;
		if (!openPluginSettings(this.app, this.plugin.manifest.id)) {
			this.focusRequest = null;
			return false;
		}
		this.applyFocus();
		return true;
	}

	// applyFocus 高亮目标区。两个调用点：①分区渲染回调（覆盖「宿主重绘设置页导致刚加上的高亮
	// 被换掉」，新建设置窗口时会发生）；②openInSystemSettings（覆盖「设置页已打开、无需重绘」）。
	// 请求按有效期自然过期，不会在之后切换页签时反复高亮。
	private applyFocus(): void {
		const request = this.focusRequest;
		if (!request) return;
		if (Date.now() > request.expiresAt) {
			this.focusRequest = null;
			return;
		}
		const target = this.containerEl.querySelector<HTMLElement>(focusSelector(request.target));
		if (!target) return; // 目标区尚未渲染：保留请求，等对应分区渲染时重试
		target.addClass("is-focused");
		target.scrollIntoView({ behavior: "smooth", block: "start" });
	}
}

interface ObsidianSettingsController {
	open(): void;
	openTabById(id: string): void;
	close(): void;
}

/** Obsidian 尚未公开声明设置控制器类型；集中封装并保留缺失接口时的安全降级。 */
export function openPluginSettings(app: App, pluginId: string): boolean {
	const setting = (app as App & { setting?: Partial<ObsidianSettingsController> }).setting;
	if (typeof setting?.open !== "function" || typeof setting.openTabById !== "function") {
		new Notice("无法自动打开设置，请在 Obsidian 系统设置中选择 Pickpen Sync");
		return false;
	}
	setting.open();
	setting.openTabById(pluginId);
	return true;
}

/**
 * 关闭设置页。设置页是模态窗：从设置里跳去别处（打开文件）时不先关掉，
 * 目标会在它背后打开，用户看不到跳转结果。接口缺失时静默降级——跳转本身仍应发生。
 */
export function closePluginSettings(app: App): void {
	const setting = (app as App & { setting?: Partial<ObsidianSettingsController> }).setting;
	if (typeof setting?.close === "function") setting.close();
}

/** 声明式设置的分区 id：与 PickpenSettingTab.getSettingDefinitions() 返回的项一一对应。 */
export type SettingsSection =
	| "account"
	| "sync"
	| "invite"
	| "subscription-status"
	| "subscription-plans"
	| "diagnostics"
	| "about";

/**
 * 订阅分区的两个分组共用同一份数据（一次请求出两块），因此按「分块」统一管理：
 * status = 当前订阅，plans = 订阅方案。
 */
type SubscriptionPart = "status" | "plans";

/** 分区 id → 订阅分块名；非订阅分区返回 null */
function subscriptionPart(section: SettingsSection): SubscriptionPart | null {
	if (section === "subscription-status") return "status";
	if (section === "subscription-plans") return "plans";
	return null;
}

/** 系统设置页的设置内容与状态订阅生命周期。每个分区由声明式渲染分配一个容器。 */
class PickpenSettingsView {
	private readonly app: App;
	private readonly plugin: PickpenPlugin;
	// 分区容器：refreshIfActive 按分区就地重绘，宿主拆除行时用返回的清理函数解除订阅
	private readonly sectionEls = new Map<SettingsSection, HTMLElement>();

	// 状态卡片实时刷新：首个分区渲染时订阅、hide 取消订阅；onChange 只就地更新卡片 DOM
	// （绝不重绘整页，避免同步高频变更打断用户输入焦点）
	private started = false;
	private statusCardEl: HTMLElement | null = null;
	private statusDotEl: HTMLElement | null = null;
	private statusTextEl: HTMLElement | null = null;
	private statusProgressEl: HTMLElement | null = null;
	private statusMetricsEl: HTMLElement | null = null;
	private statusBarFillEl: HTMLElement | null = null;
	private statusPercentEl: HTMLElement | null = null;
	private statusPathEl: HTMLElement | null = null;
	/** 冲突副本入口：有存量时才显示（点开第一个，处理入口不在设置页） */
	private statusConflictEl: HTMLAnchorElement | null = null;
	private readonly statusRefresh = new StatusRefresh(() => this.refreshStatusCard());
	private statusListener = () => {
		const status = deriveStatus(this.plugin.settings, syncState);
		this.statusRefresh.request(JSON.stringify([status.mod, status.text, syncState.sessionRunning, syncState.progress?.phase]));
	};
	private active = false;
	// 各分区订阅清理（分区重建/被拆除时解除）
	private debugCleanup: (() => void) | null = null;
	private inviteCleanup: (() => void) | null = null;
	// 订阅两块共用一份数据与一个加载器：容器按分块记录，重建合并到同一微任务
	private readonly subscriptionEls = new Map<SubscriptionPart, HTMLElement>();
	private subscriptionCleanup: (() => void) | null = null;
	private subscriptionRebuildQueued = false;

	constructor(app: App, plugin: PickpenPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	/** 渲染一个分区到宿主给的容器（重复调用即就地重建该分区） */
	render(section: SettingsSection, containerEl: HTMLElement): void {
		this.active = true;
		this.disposeSection(section); // 重建前先解除该分区上一次的订阅
		this.sectionEls.set(section, containerEl);
		containerEl.empty();
		this.statusRefresh.cancel();
		const settings = this.plugin.settings;

		switch (section) {
			case "account":
				this.renderAccount(containerEl, settings);
				break;
			case "invite":
				// —— 邀请（与「账号和仓库」同级；未登录时只显示登录引导）——
				this.inviteCleanup = renderInviteSection(containerEl, this.plugin);
				break;
			case "subscription-status":
				// 订阅：移动端交给官网移动收银台；其他平台在插件内显示二维码。
				// 「当前订阅 / 订阅方案」是两个分组，共用一份数据（见 queueSubscriptionRebuild）。
				this.mountSubscriptionPart("status", containerEl);
				break;
			case "subscription-plans":
				this.mountSubscriptionPart("plans", containerEl);
				break;
			case "sync":
				this.renderSync(containerEl, settings);
				break;
			case "diagnostics":
				this.renderDiagnostics(containerEl, settings);
				break;
			case "about":
				renderAboutAndFeedback(containerEl, this.plugin);
				break;
		}

		// 订阅状态变更（首个分区渲染时注册，hide 时取消；listener 保存固定引用以便 off 匹配）
		if (!this.started) {
			this.started = true;
			syncState.onChange(this.statusListener);
		}
	}

	/** 分区被重建或拆除时解除该分区的订阅与 DOM 引用（幂等） */
	disposeSection(section: SettingsSection): void {
		this.sectionEls.delete(section);
		const part = subscriptionPart(section);
		if (part) {
			// 摘掉该分块后由 queueSubscriptionRebuild 决定重建还是只清理
			this.subscriptionEls.delete(part);
			this.queueSubscriptionRebuild();
			return;
		}
		switch (section) {
			case "invite":
				this.inviteCleanup?.();
				this.inviteCleanup = null;
				break;
			case "diagnostics":
				this.debugCleanup?.();
				this.debugCleanup = null;
				break;
			case "account":
				// 状态卡片是唯一会持续刷新的分区
				this.statusRefresh.cancel();
				this.clearStatusCardRefs();
				break;
			default:
				break;
		}
	}

	// 订阅分块挂载：宿主给的声明行内套分区容器，并**同步**建好分块元素——聚焦高亮
	// （.pickpen-subscription-plans）与后续重建都以它为锚点，不能推迟到微任务里创建。
	private mountSubscriptionPart(part: SubscriptionPart, containerEl: HTMLElement): void {
		const sectionEl = containerEl.createDiv({ cls: "pickpen-settings-section" });
		this.subscriptionEls.set(part, sectionEl.createDiv({ cls: `pickpen-subscription pickpen-subscription-${part}` }));
		this.queueSubscriptionRebuild();
	}

	// 两块由宿主在同一次渲染里同步挂载/拆除，这里用微任务合并成一次重建：
	// 既保证只发一轮请求、两块数据同源，又避免先挂载的那块被后一块的清理连带拆掉。
	private queueSubscriptionRebuild(): void {
		if (this.subscriptionRebuildQueued) return;
		this.subscriptionRebuildQueued = true;
		queueMicrotask(() => {
			this.subscriptionRebuildQueued = false;
			this.rebuildSubscription();
		});
	}

	private rebuildSubscription(): void {
		this.subscriptionCleanup?.();
		this.subscriptionCleanup = null;
		if (this.subscriptionEls.size === 0) return;
		// 只挂上一块时另一块写进游离节点占位：内容不可见，等它挂载后这轮重建会再触发
		const detached = createDiv();
		const blocks = {
			status: this.subscriptionEls.get("status") ?? detached,
			plans: this.subscriptionEls.get("plans") ?? detached,
		};
		// 分块元素是复用锚点：重建前清空上一轮加载器写的内容
		blocks.status.empty();
		blocks.plans.empty();
		this.subscriptionCleanup = Platform.isMobile
			? renderMobileSubscriptionSection(blocks, this.plugin)
			: renderSubscriptionSection(blocks, this.plugin);
	}

	/** 账号和仓库：同步状态卡片、登录 / 退出登录、仓库绑定与加密解锁 */
	private renderAccount(containerEl: HTMLElement, settings: PluginSettings): void {
		const loggedIn = !!settings.accessToken;

		// 分区标题由声明式分组提供；pickpen-account-section 仅供跳转聚焦定位
		const accountSectionEl = containerEl.createDiv({ cls: "pickpen-settings-section pickpen-account-section" });

		// 同步状态卡片（实时状态和阶段进度，订阅 syncState 刷新）
		this.renderStatusCard(accountSectionEl);
		if (loggedIn) {
			// 已登录：账号信息 + 退出登录
			new Setting(accountSectionEl)
				.setName(settings.email || "已登录")
				.setDesc("已登录")
				.addButton((btn) =>
					btn
						.setButtonText("退出登录")
						.onClick(async () => {
							await this.plugin.logout(); // 退出登录 = 解绑（清 token + 仓库绑定）
							this.refreshIfActive();
						}),
				);
		} else {
			// 邮箱（trim + lowercase 即存）
			new Setting(accountSectionEl).setName("邮箱").addText((text) =>
				text
					.setPlaceholder("name@example.com")
					.setValue(settings.email)
					.onChange((value) => {
						settings.email = value.trim().toLowerCase();
						this.plugin.sessionStore.setEmail(settings.email); // 邮箱属会话域：只写设备本地
					}),
			);
			// 验证码（不持久化，仅登录用）
			let code = "";
			const codeSetting = new Setting(accountSectionEl).setName("验证码");
			codeSetting.addText((text) => {
				text.setPlaceholder("6 位验证码").onChange((value) => (code = value.trim()));
				text.inputEl.type = "text";
			});
			// 获取验证码：60s 倒计时禁用防重复提交
			let countdown = 0;
			let countdownTimer: number | null = null;
			codeSetting.addButton((btn) => {
				const setButton = () => {
					btn.setButtonText(countdown > 0 ? `${countdown}s` : "获取验证码");
					btn.setDisabled(countdown > 0);
				};
				btn.setButtonText("获取验证码").onClick(async () => {
					if (countdown > 0) return;
					codeSetting.setErrorMessage(null);
					try {
						await this.plugin.auth.sendCode(settings.email);
						new Notice("验证码已发送，请查收邮箱");
						countdown = 60;
						setButton();
						countdownTimer = window.setInterval(() => {
							countdown -= 1;
							if (countdown <= 0 && countdownTimer !== null) {
								window.clearInterval(countdownTimer);
								countdownTimer = null;
							}
							setButton();
						}, 1000);
					} catch (err) {
						debugLog.error(`[pickpen] 发送验证码失败，错误码：${errorCode(err) ?? "unknown"}`);
						const msg = sendCodeErrorMessage(err);
						codeSetting.setErrorMessage(msg);
						new Notice(msg);
					}
				});
			});
			// 邀请码（选填，不持久化）：仅在该邮箱首次注册时被服务端采纳，已注册用户填写会被忽略
			let inviteCode = "";
			new Setting(accountSectionEl)
				.setName("邀请码（选填）")
				.setDesc("好友邀请你注册时填写；已有账号可留空")
				.addText((text) => {
					text.setPlaceholder("6 位数字").onChange((value) => {
						inviteCode = value.replace(/\D/g, "").slice(0, 6);
						// 过滤后可能与输入不同（例如粘贴带空格），回写保证界面与提交值一致
						if (text.getValue() !== value) text.setValue(inviteCode);
					});
					text.inputEl.inputMode = "numeric";
					text.inputEl.maxLength = 6;
					text.inputEl.autocomplete = "off";
				});
			// 登录（登录即注册；loading 防重复提交，错误按网络/认证分类）
			const loginSetting = new Setting(accountSectionEl).setName("登录").setDesc("账号不存在将自动注册（登录即注册）");
			let busy = false;
			loginSetting.addButton((btn) =>
				btn
					.setButtonText("登录")
					.setCta()
					.onClick(async () => {
						if (busy) return;
						busy = true;
						loginSetting.setErrorMessage(null);
						btn.setDisabled(true).setButtonText("登录中…");
						try {
							await this.plugin.auth.login(settings.email, code, inviteCode);
							await this.plugin.afterLogin(() => this.refreshIfActive()); // 同账号重登沿用绑定；否则打开仓库管理
							this.refreshIfActive();
						} catch (err) {
							debugLog.error(`[pickpen] 登录失败，错误码：${errorCode(err) ?? "unknown"}`);
							const msg = loginErrorMessage(err);
							loginSetting.setErrorMessage(msg);
							new Notice(msg);
							btn.setDisabled(false).setButtonText("登录");
						} finally {
							busy = false;
						}
					}),
			);
		}

		// 仓库（vault_id 为绑定主键，名字仅展示；绑定后不可换绑其他仓库）
		new Setting(accountSectionEl)
			.setName("仓库")
			.setDesc(settings.vaultName ? `已绑定：${settings.vaultName}` : "未绑定（登录后选择）")
			.addButton((btn) => {
				btn.setDisabled(!loggedIn);
				if (loggedIn && !settings.vaultId) {
					btn.setCta();
					btn.setButtonText("绑定仓库");
				} else {
					btn.setButtonText("仓库管理");
				}
				btn.onClick(() => openVaultManager(this.app, this.plugin, () => this.refreshIfActive()));
			});

		// 端到端加密仓库：解锁状态与「在本设备记住」
		if (loggedIn && settings.vaultId && vaultKeys.isEncrypted()) this.renderEncryptionSection(accountSectionEl);
	}

	/**
	 * 同步（specs/sync/spec.md 需求 1 + 需求 3）：已删除的文件入口 + 同步范围（选择性同步）。
	 * 范围口径与默认值对齐 Obsidian 官方：笔记格式恒同步；图片/音频/视频/PDF 默认开、其他类型默认关；
	 * 配置文件分类前 6 项默认开、第三方插件两项默认关。
	 */
	private renderSync(containerEl: HTMLElement, settings: PluginSettings): void {
		// 分区标题由声明式分组提供
		const sectionEl = containerEl.createDiv({ cls: "pickpen-settings-section pickpen-sync-section" });

		// 已删除的文件（需求 3）：位置对齐官方「设置 → 同步 → 已删除文件」
		new Setting(sectionEl)
			.setName("已删除的文件")
			.setDesc("浏览、恢复已删除的文件。")
			.addButton((btn) =>
				btn.setButtonText("查看").onClick(() => {
					if (!settings.accessToken || !settings.vaultId) {
						new Notice("请先登录并绑定仓库");
						return;
					}
					openDeletedFiles(this.app, this.plugin);
				}),
			);

		const selective = settings.selective;
		// 任何一项开关都会改变同步范围：必须落盘 + 强制重算，否则 L 里该进/该出的路径不会自行变化
		const commit = async (): Promise<void> => {
			await this.plugin.saveSettings();
			this.plugin.session.requestRun({ forceAudit: true });
		};
		const toggle = (
			name: string,
			desc: string,
			get: () => boolean,
			set: (value: boolean) => void,
		): void => {
			new Setting(sectionEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((el) =>
					el.setValue(get()).onChange(async (value) => {
						set(value);
						await commit();
					}),
				);
		};
		const extensions = (list: string[]): string => list.join("、");

		toggle(
			"同步图片",
			`同步以下类型的图片文件：${extensions(IMAGE_EXTS)}。`,
			() => selective.images,
			(v) => (selective.images = v),
		);
		toggle(
			"同步音频",
			`同步以下类型的音频文件：${extensions(AUDIO_EXTS)}。`,
			() => selective.audio,
			(v) => (selective.audio = v),
		);
		toggle(
			"同步视频",
			`同步以下类型的视频文件：${extensions(VIDEO_EXTS)}。`,
			() => selective.video,
			(v) => (selective.video = v),
		);
		toggle(
			"同步 PDF",
			`同步以下类型的 PDF 文件：${extensions(PDF_EXTS)}。`,
			() => selective.pdf,
			(v) => (selective.pdf = v),
		);
		toggle(
			"同步所有其他类型文件",
			"同步那些无法在 Obsidian 中打开的文件。",
			() => selective.other,
			(v) => (selective.other = v),
		);

		// 需要排除的文件夹（[管理] 打开列表；目录按整棵子树排除）
		const folders = selective.excludedFolders;
		new Setting(sectionEl)
			.setName("需要排除的文件夹")
			.setDesc(
				folders.length > 0
					? `目前这些文件夹被排除在外：${folders.join("、")}`
					: "防止某些文件夹被同步。排除后其整棵子树都不参与同步。",
			)
			.addButton((btn) =>
				btn.setButtonText("管理").onClick(() =>
					openFolderExclusionManager(this.app, this.plugin, () => this.refreshIfActive()),
				),
			);

		// —— 配置目录内的文件：以下 8 项为官方分类的逐项开关（列表前不再有分组小标题）——
		toggle(
			"主要设置",
			"同步编辑器、文件与链接等方面的设置（app.json、types.json）。",
			() => selective.config.app,
			(v) => (selective.config.app = v),
		);
		toggle(
			"外观",
			"同步外观设置，比如基础颜色、当前应用的主题、开启的 CSS 样式代码片段等设置（appearance.json）。",
			() => selective.config.appearance,
			(v) => (selective.config.appearance = v),
		);
		toggle(
			"主题与 CSS 代码片段",
			"同步已保存的主题与 CSS 代码片段文件。文件启用情况由「外观」决定。",
			() => selective.config.appearanceData,
			(v) => (selective.config.appearanceData = v),
		);
		toggle(
			"快捷键",
			"同步自定义快捷键（hotkeys.json）。",
			() => selective.config.hotkey,
			(v) => (selective.config.hotkey = v),
		);
		toggle(
			"核心插件的启用情况",
			"同步核心插件的启用情况（core-plugins.json）。",
			() => selective.config.corePlugin,
			(v) => (selective.config.corePlugin = v),
		);
		toggle(
			"核心插件设置",
			"同步核心插件的设置信息。",
			() => selective.config.corePluginData,
			(v) => (selective.config.corePluginData = v),
		);
		toggle(
			"第三方插件启用情况",
			"同步社区插件的启用情况（community-plugins.json）。",
			() => selective.config.communityPlugin,
			(v) => (selective.config.communityPlugin = v),
		);
		toggle(
			"已安装的第三方插件",
			"同步已安装的社区插件，包括插件中的 .js、.css、manifest.json 等文件，以及插件的设置信息。pickpen 自身不会被同步。",
			() => selective.config.communityPluginData,
			(v) => (selective.config.communityPluginData = v),
		);
	}

	/** 诊断：远端地址、设备 / 构建信息与调试日志面板 */
	private renderDiagnostics(containerEl: HTMLElement, settings: PluginSettings): void {
		// 分区标题由声明式分组提供
		const diagnosticsSectionEl = containerEl.createDiv({ cls: "pickpen-settings-section" });

		// 远端地址（构建期常量 BASE_URL 注入，固定不可改）
		new Setting(diagnosticsSectionEl)
			.setName("远端地址")
			.addText((text) => text.setValue(BASE_URL).setDisabled(true));

		// 设备 ID + 构建环境 + 插件版本合并为一行（诊断用，等宽展示）
		const diagSetting = new Setting(diagnosticsSectionEl).setName("诊断信息");
		diagSetting.descEl.createDiv({ cls: "pickpen-mono", text: `设备 ID：${settings.deviceId}` });
		diagSetting.descEl.createDiv({ cls: "pickpen-mono", text: `构建环境：${process.env.PICKPEN_ENV ?? "test"}` });
		// 插件版本：本地 dev 构建（经构建脚本安装）附加 BUILD_TAG（ASCII）标识，正式渠道包不带
		diagSetting.descEl.createDiv({
			cls: "pickpen-mono",
			text: BUILD_TAG
				? `插件版本：${this.plugin.manifest.version}（本地构建 ${BUILD_TAG}）`
				: `插件版本：${this.plugin.manifest.version}`,
		});

		// 调试日志开关 + 开启后实时日志面板（仅插件主动写入的脱敏日志）
		this.renderDebugSection(diagnosticsSectionEl);
	}

	// 系统设置页 hide：取消订阅防泄漏
	dispose(): void {
		this.active = false;
		this.sectionEls.clear();
		this.statusRefresh.cancel();
		if (this.started) {
			this.started = false;
			syncState.off(this.statusListener);
		}
		this.debugCleanup?.();
		this.debugCleanup = null;
		this.subscriptionEls.clear();
		this.subscriptionCleanup?.();
		this.subscriptionCleanup = null;
		this.inviteCleanup?.();
		this.inviteCleanup = null;
		this.clearStatusCardRefs();
	}

	/** 状态卡片在重建 / 拆除后置空，避免持有已脱离文档的节点 */
	private clearStatusCardRefs(): void {
		this.statusCardEl = null;
		this.statusDotEl = null;
		this.statusTextEl = null;
		this.statusProgressEl = null;
		this.statusMetricsEl = null;
		this.statusBarFillEl = null;
		this.statusPercentEl = null;
		this.statusPathEl = null;
	}

	// refreshIfActive 就地重建当前已渲染的分区（登录 / 退出 / 仓库变更后刷新）；
	// 未渲染或已从文档移除的分区跳过，等宿主下次渲染
	private refreshIfActive(): void {
		if (!this.active) return;
		for (const [section, containerEl] of [...this.sectionEls]) {
			if (containerEl.isConnected) this.render(section, containerEl);
		}
	}

	// renderDebugSection 调试日志：开关控制 data.json 持久化；开启后展示实时日志面板
	// （面板只追加新条目、不整页重绘；分区重建与 dispose 时先解绑订阅防泄漏）
	private renderDebugSection(containerEl: HTMLElement): void {
		this.debugCleanup?.();
		this.debugCleanup = null;
		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName("调试日志")
			.setDesc("开启后记录并显示 Pickpen Sync 的脱敏诊断日志；不会收集 Obsidian 或其他插件的控制台输出")
			.addToggle((t) =>
					t.setValue(!!settings.debugLog).onChange(async (on) => {
					settings.debugLog = on;
					this.plugin.setDebugEnabled(on);
					await this.plugin.saveSettings();
					this.refreshIfActive(); // 重绘以展开/收起日志面板
				}),
			);

		if (!settings.debugLog) return;

		// 级别筛选：用 Obsidian 自带 Dropdown 组件（主题风格一致、聚焦无突兀大边框）。
		// 语义：普通 = log 级别并入「全部」；普通(全部) → 信息 → 调试 → 警告 → 错误，自低到高
		type LevelFilter = DebugLevel | "all";
		let levelFilter: LevelFilter = "all";
		new Setting(containerEl)
			.setName("日志级别")
			.addDropdown((dd) => {
				dd.addOption("all", "普通（全部）");
				dd.addOption("info", "信息");
				dd.addOption("debug", "调试");
				dd.addOption("warn", "警告");
				dd.addOption("error", "错误");
				dd.setValue(levelFilter);
				dd.onChange((v) => {
					levelFilter = (v as LevelFilter) || "all";
					renderAll(); // 重渲染当前筛选结果
				});
			});

		const panel = containerEl.createDiv({ cls: "pickpen-debug-log" });
		const bar = panel.createDiv({ cls: "pickpen-debug-log-bar" });
		new ButtonComponent(bar)
			.setButtonText("清空")
			.onClick(() => {
				debugLog.clear();
				renderAll(); // 缓冲与展示同步清空
			});

		const box = panel.createDiv({ cls: "pickpen-debug-log-box" });
		const filteredEntries = (): readonly DebugLogEntry[] => {
			const dump = debugLog.dump();
			return levelFilter === "all" ? dump : dump.filter((e) => e.level === levelFilter);
		};
		const appendLine = (entry: DebugLogEntry): void => {
			box.createDiv({ cls: `pickpen-dbg-line is-${entry.level}`, text: `${entry.time}  ${entry.message}` });
			box.scrollTop = box.scrollHeight; // 始终滚到底部看最新
		};
		const renderAll = (): void => {
			box.empty();
			const list = filteredEntries();
			if (list.length === 0) {
				// 无日志（或当前级别无匹配）也保留默认高度，给一行浅色提示
				box.createDiv({ cls: "pickpen-debug-log-empty", text: "暂无日志（当前级别无匹配时同样如此）" });
				return;
			}
			for (const entry of list) appendLine(entry);
			box.scrollTop = box.scrollHeight;
		};
		renderAll();

		// 复制当前筛选可见的日志（移动端 WebView 不支持 Clipboard API 时提示手动复制）
		new ButtonComponent(bar)
			.setButtonText("复制")
			.onClick(async () => {
				const entries = filteredEntries();
				if (entries.length === 0) {
					new Notice("暂无日志可复制");
					return;
				}
				const text = entries.map((e) => `${e.time} [${e.level.toUpperCase()}] ${e.message}`).join("\n");
				const copied = await copyText(text);
				new Notice(copied ? `已复制 ${entries.length} 条日志` : "复制失败：请手动长按选择复制");
			});

		// 新日志：命中当前筛选才上屏（不命中仍留缓冲，切回级别时 renderAll 补显）
		this.debugCleanup = debugLog.subscribe((entry) => {
			if (levelFilter === "all" || entry.level === levelFilter) appendLine(entry);
		});

		// —— 提醒效果预览（仅调试观感，不动真实用量判断）——
		new Setting(containerEl)
			.setName("提醒效果预览")
			.setDesc("触发示例提醒，评估移动端观感与文案；不影响真实用量。")
			.addButton((btn) =>
				btn.setButtonText("接近上限").onClick(() => {
					new Notice("Pickpen Sync：云端存储已使用 82%，即将用满。为避免同步中断，可升级容量或联系支持。");
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("已超限").onClick(() => {
					const n = new Notice("Pickpen Sync：云端存储已用满，笔记同步已暂停。升级后可自动恢复同步。", 0);
					n.messageEl.addClass("pickpen-notice-alert");
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("升级引导").onClick(() => {
					// 内联 Modal：说明原因 + 行动按钮（去升级当前为预留占位）
					const modal = new (class extends Modal {
						onOpen(): void {
							this.setTitle("Pickpen Sync 用量提醒");
							this.contentEl.createDiv({
								text: "你的云端存储用量已达上限，新改动暂时无法上传。升级后可继续同步，你的笔记不会丢失。",
							});
							new Setting(this.contentEl)
								.setName("下一步")
								.addButton((b) =>
									b.setButtonText("知道了").onClick(() => modal.close()),
								)
								.addButton((b) =>
									b
										.setButtonText("去升级")
										.setCta()
										.onClick(() => {
											modal.close();
											new Notice("预留：将打开充值/开通页（后端接入后生效）");
										}),
								);
						}
					})(this.app);
					modal.open();
				}),
			);
	}

	// renderStatusCard 状态卡片：状态点、阶段进度和当前路径（class 由 deriveStatus 决定）
	// renderEncryptionSection 加密仓库的状态区：只展示解锁状态与「在本设备记住」，
	// 不提供锁定/解锁按钮——需要解锁时同步会主动弹窗。
	// 仓库密码绝不写入设置项（data.json 会随 vault 被 iCloud 同步到其他设备）。
	private renderEncryptionSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("端到端加密")
			.setDesc(
				vaultKeys.isLocked()
					? "未解锁：需要输入仓库密码后才能继续同步"
					: "已解锁：内容在本机加解密，服务端只保存密文",
			);
		new Setting(containerEl)
			.setName("在本设备记住仓库密码")
			.setDesc(
				"默认开启：重启本设备后自动解锁，并可在仓库管理中查看密码；关闭后每次重启都需要重新输入密码。" +
					"密码与内容密钥只保存在设备本地，不会随 vault 同步到其他设备；" +
					"共用该设备的他人可读取本地文件并解密仓库内容，请谨慎保留。",
			)
			.addToggle((toggle) =>
				toggle.setValue(vaultKeys.remember).onChange((value) => {
					this.plugin.setRememberVaultPassword(value);
					if (value && vaultKeys.isLocked()) new Notice("将在下次解锁后记住");
				}),
			);
	}

	private renderStatusCard(containerEl: HTMLElement): void {
		const card = containerEl.createDiv({ cls: "pickpen-status-card" });
		this.statusCardEl = card;
		this.statusDotEl = card.createDiv({ cls: "pickpen-status-dot" });
		const content = card.createDiv({ cls: "pickpen-status-content" });
		this.statusTextEl = content.createDiv({ cls: "pickpen-status-text" });
		this.statusProgressEl = content.createDiv({ cls: "pickpen-status-progress" });
		// 进度条：纯装饰（百分比文本已表达同一信息），不进入无障碍树
		const metrics = content.createDiv({ cls: "pickpen-status-metrics", attr: { "aria-hidden": "true" } });
		this.statusMetricsEl = metrics;
		this.statusBarFillEl = metrics.createDiv({ cls: "pickpen-status-bar" }).createDiv({ cls: "pickpen-status-bar-fill" });
		this.statusPercentEl = metrics.createDiv({ cls: "pickpen-status-percent" });
		this.statusPathEl = content.createDiv({ cls: "pickpen-status-path" });
		// 冲突副本入口。href="#" + preventDefault：链接天然可聚焦、可回车触发，
		// 不必再用 tabIndex + role 手工补齐无障碍语义
		this.statusConflictEl = content.createEl("a", { cls: "pickpen-status-conflict", href: "#" });
		this.statusConflictEl.addEventListener("click", (evt) => {
			evt.preventDefault();
			this.openFirstConflictCopy();
		});
		this.refreshStatusCard();
	}

	/** 打开第一个待处理冲突副本（v1 不做列表视图，逐个处理即可） */
	private openFirstConflictCopy(): void {
		const path = syncState.conflictCopyPaths[0];
		if (!path) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		// 先关设置页再打开文件，否则文件开在模态窗背后，用户看不到跳转结果。
		// 延后一拍是照 Obsidian 自己的用法（app.js 里关闭设置后同样用 setTimeout 接后续动作）：
		// 关闭过程本身要收尾，同一拍里接着做事会与它的焦点恢复打架
		closePluginSettings(this.app);
		window.setTimeout(() => {
			void this.app.workspace.getLeaf(false).openFile(file);
		}, 0);
	}

	// refreshStatusCard 就地更新卡片 DOM（订阅回调；绝不重绘整页）
	private refreshStatusCard(): void {
		if (!this.statusCardEl) return;
		const s = deriveStatus(this.plugin.settings, syncState);
		this.statusCardEl.setAttribute("class", `pickpen-status-card is-${s.mod}`);
		const running = syncState.sessionRunning ? syncState.progress : null;
		const progress = running ? formatProgress(running) : null;
		const percent = running ? progressPercent(running) : null;
		this.statusTextEl!.textContent = s.mod === "syncing" && progress ? `同步中：${progress.text}` : s.text;
		this.statusProgressEl!.textContent = progress && s.mod !== "syncing" ? progress.text : "";
		this.statusProgressEl!.hidden = !progress || s.mod === "syncing";
		// 进度条只由总量是否可知决定显隐；阶段文案在主行与独立行之间搬家不影响它
		this.statusMetricsEl!.hidden = percent === null;
		if (percent !== null) {
			this.statusBarFillEl!.style.width = `${percent}%`;
			this.statusPercentEl!.textContent = `${percent}%`;
		}
		this.statusPathEl!.textContent = progress?.path ?? "";
		this.statusPathEl!.hidden = !progress?.path;
		const conflicts = syncState.conflictCopyPaths.length;
		this.statusConflictEl!.textContent = conflicts > 0 ? `查看冲突副本（${conflicts}）` : "";
		this.statusConflictEl!.hidden = conflicts === 0;
	}
}

// deriveStatus 状态判定（优先级：未登录 → 暂停 → 出错 → 受阻 → 同步中 → 冲突副本 → 已全部同步）
export function deriveStatus(settings: PluginSettings, state: SyncState): { mod: string; text: string } {
	if (!settings.accessToken) return { mod: "yellow", text: "未登录：登录后开始同步" };
	if (state.pausedReason) return { mod: "yellow", text: `已暂停：${state.pausedReason}` };
	if (state.storageLimitExceeded) return { mod: "red", text: "同步已暂停：云端存储已满" };
	if (state.lastError) return { mod: "red", text: `同步出错：${state.lastError}` };
	if (state.blockedPaths.length > 0) return { mod: "yellow", text: `同步受阻：${state.blockedPaths.length} 个文件被阻塞（超限/冲突）` };
	if (state.sessionRunning) return { mod: "syncing", text: "同步中：正在准备同步" };
	// 冲突副本不是同步失败（两边内容都在），所以排在「同步中」之后、完成态之前：黄色提醒而非红色
	if (state.conflictCopyPaths.length > 0)
		return { mod: "yellow", text: `同步完成，有 ${state.conflictCopyPaths.length} 个冲突副本待处理` };
	return { mod: "green", text: "已全部同步" };
}

// loginErrorMessage 登录错误分类：11001 邮箱格式错误 → 11003 验证码错误 → 其余按网络不可达
function loginErrorMessage(err: unknown): string {
	switch (errorCode(err)) {
		case ErrCode.InvalidCredentials:
			return "登录失败：邮箱或验证码格式错误";
		case ErrCode.InvalidOrExpiredCode:
			return "登录失败：验证码错误或已过期";
		case ErrCode.InviteCodeInvalid:
			// 邀请码只在首次注册时校验；校验失败不会消费邮箱验证码，改对后可直接重试
			return "登录失败：邀请码无效，请检查或清空后重试";
		default:
			return "登录失败：网络不可达或服务端异常";
	}
}

// sendCodeErrorMessage 发送验证码错误分类：11001 邮箱格式错误 → 11004 过于频繁 → 其余按网络不可达
function sendCodeErrorMessage(err: unknown): string {
	switch (errorCode(err)) {
		case ErrCode.InvalidCredentials:
			return "发送失败：邮箱格式错误";
		case ErrCode.SendCodeTooFrequent:
			return "发送过于频繁，请稍后再试";
		default:
			return "发送失败：网络不可达或服务端异常";
	}
}

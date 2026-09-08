// 设置面板（Snapshot 同步 v2）：账号登录、仓库绑定、同步参数与诊断。
// 防抖窗口客户端默认 10s，服务端可通过 GetVaultHead 动态下发；面板只读展示当前生效值。

import { App, ButtonComponent, Modal, Notice, Platform, PluginSettingTab, Setting } from "obsidian";

import { renderAboutAndFeedback } from "./about";
import { debugLog, type DebugLevel, type DebugLogEntry } from "./debug-log";
import type PickpenPlugin from "./index";
import { ErrCode, errorCode, isUnauthenticated } from "./remote-connect";
import { syncState, type SyncState } from "./sync-state";
import { renderSubscriptionSection } from "./subscription-view";
import { renderMobileSubscriptionSection } from "./mobile-subscription-view";
import { BASE_URL, BUILD_TAG, DEBOUNCE_MS, type PluginSettings } from "./types";
import { openVaultManager } from "./vault-manager";

export class PickpenSettingTab extends PluginSettingTab {
	private readonly plugin: PickpenPlugin;
	private readonly view: PickpenSettingsView;
	private focusSubscriptionOnDisplay = false;

	constructor(app: App, plugin: PickpenPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.view = new PickpenSettingsView(app, plugin, this.containerEl);
	}

	display(): void {
		this.view.display();
		this.scheduleSubscriptionFocus();
	}

	override hide(): void {
		this.view.dispose();
		super.hide();
	}

	/** 从 Ribbon 等插件入口打开 Obsidian 系统设置，并选中 Pickpen Sync。 */
	openInSystemSettings(options?: { focusSubscription?: boolean }): void {
		this.focusSubscriptionOnDisplay = !!options?.focusSubscription;
		if (!openPluginSettings(this.app, this.plugin.manifest.id)) {
			this.focusSubscriptionOnDisplay = false;
			return;
		}
		this.scheduleSubscriptionFocus();
	}

	private scheduleSubscriptionFocus(): void {
		if (!this.focusSubscriptionOnDisplay) return;
		window.requestAnimationFrame(() => {
			if (!this.focusSubscriptionOnDisplay) return;
			const subscription = this.containerEl.querySelector<HTMLElement>(".pickpen-subscription-plans");
			if (!subscription) return;
			this.focusSubscriptionOnDisplay = false;
			subscription.addClass("is-focused");
			subscription.scrollIntoView({ behavior: "smooth", block: "start" });
		});
	}
}

interface ObsidianSettingsController {
	open(): void;
	openTabById(id: string): void;
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

/** 系统设置页的设置内容与状态订阅生命周期。 */
class PickpenSettingsView {
	private readonly app: App;
	private readonly plugin: PickpenPlugin;
	private readonly containerEl: HTMLElement;

	// 状态卡片实时刷新：display 首次订阅、hide 取消订阅；onChange 只就地更新卡片 DOM
	// （绝不重绘整页，避免同步高频变更打断用户输入焦点）
	private started = false;
	private statusCardEl: HTMLElement | null = null;
	private statusDotEl: HTMLElement | null = null;
	private statusTextEl: HTMLElement | null = null;
	private debounceInputEl: HTMLInputElement | null = null;
	private statusListener = () => {
		this.refreshStatusCard();
		this.refreshDebounceDisplay();
	};
	private active = false;
	// 调试日志面板的订阅清理（display 重建/视图 hide 时解除）
	private debugCleanup: (() => void) | null = null;
	private subscriptionCleanup: (() => void) | null = null;

	constructor(app: App, plugin: PickpenPlugin, containerEl: HTMLElement) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = containerEl;
	}

	display(): void {
		this.active = true;
		this.subscriptionCleanup?.();
		this.subscriptionCleanup = null;
		const { containerEl } = this;
		containerEl.empty();
		this.debounceInputEl = null;
		const settings = this.plugin.settings;
		const loggedIn = !!settings.accessToken;

		// —— 账号和仓库 ——
		new Setting(containerEl).setHeading().setName("账号和仓库");
		const accountSectionEl = containerEl.createDiv({ cls: "pickpen-settings-section" });

		// 同步状态卡片（单行实时状态，订阅 syncState 刷新）
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
							this.display();
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
							await this.plugin.auth.login(settings.email, code);
							await this.plugin.afterLogin(() => this.refreshIfActive()); // 同账号重登沿用绑定；否则打开仓库管理
							this.display();
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

		// 移动端交给官网移动收银台；其他平台在插件内显示二维码。
		if (Platform.isMobile) {
			this.subscriptionCleanup = renderMobileSubscriptionSection(containerEl, this.plugin);
		} else {
			this.subscriptionCleanup = renderSubscriptionSection(containerEl, this.plugin);
		}

		// —— 同步 ——
		new Setting(containerEl).setHeading().setName("同步");
		const syncSectionEl = containerEl.createDiv({ cls: "pickpen-settings-section" });

		// 排除项追加（默认清单 + 追加）
		new Setting(syncSectionEl)
			.setName("排除项追加")
			.setDesc("每行一项；目录前缀 / 前缀* 为 basename 匹配 / *后缀 为后缀匹配。默认已排除 .obsidian/、.trash/、隐藏文件等")
			.addTextArea((text) =>
				text
					.setPlaceholder("例如：\nprivate/\n*.drawio")
					.setValue(settings.extraExcludes.join("\n"))
					.onChange(async (value) => {
						settings.extraExcludes = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s !== "");
						await this.plugin.saveSettings();
					}),
			);

		// 冲突策略（spec §8.2：双方不同内容保留双副本，不用 mtime 裁决）
		new Setting(syncSectionEl)
			.setName("冲突策略")
			.setDesc("双方并发修改时保留冲突副本，任一方内容不丢失")
			.addText((text) => text.setValue("保留冲突副本").setDisabled(true));

		// 变更防抖窗口（客户端默认 + 服务端下发，非用户设置项；local-hint 合并窗口）
		new Setting(syncSectionEl)
			.setName("变更防抖")
			.setDesc(`本地变更合并窗口：客户端默认 ${DEBOUNCE_MS / 1000}s，服务端可调整`)
			.addText((text) => {
				this.debounceInputEl = text.inputEl;
				text.setValue(`${syncState.localDebounceMs / 1000}s`).setDisabled(true);
			});

		// —— 诊断 ——
		new Setting(containerEl).setHeading().setName("诊断");
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

		// 订阅状态变更（首次 display 注册，hide 时取消；listener 保存固定引用以便 off 匹配）
		if (!this.started) {
			this.started = true;
			syncState.onChange(this.statusListener);
		}

		// —— 关于与反馈 ——
		renderAboutAndFeedback(containerEl, this.plugin);
	}

	// 系统设置页 hide：取消订阅防泄漏
	dispose(): void {
		this.active = false;
		if (this.started) {
			this.started = false;
			syncState.off(this.statusListener);
		}
		this.debugCleanup?.();
		this.debugCleanup = null;
		this.subscriptionCleanup?.();
		this.subscriptionCleanup = null;
		this.statusCardEl = null;
		this.statusDotEl = null;
		this.statusTextEl = null;
		this.debounceInputEl = null;
	}

	private refreshDebounceDisplay(): void {
		if (this.debounceInputEl) this.debounceInputEl.value = `${syncState.localDebounceMs / 1000}s`;
	}

	private refreshIfActive(): void {
		if (this.active) this.display();
	}

	// renderDebugSection 调试日志：开关控制 data.json 持久化；开启后展示实时日志面板
	// （面板只追加新条目、不整页重绘；display 重建与 dispose 时先解绑订阅防泄漏）
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

		// 复制当前筛选可见的日志：webview（移动端）navigator.clipboard 可能不可用，回退 textarea+execCommand
		new ButtonComponent(bar)
			.setButtonText("复制")
			.onClick(async () => {
				const entries = filteredEntries();
				if (entries.length === 0) {
					new Notice("暂无日志可复制");
					return;
				}
				const text = entries.map((e) => `${e.time} [${e.level.toUpperCase()}] ${e.message}`).join("\n");
				const ok = async (): Promise<boolean> => {
					try {
						await navigator.clipboard.writeText(text);
						return true;
					} catch {
						return false;
					}
				};
				const fallback = (): boolean => {
					const ta = document.createElement("textarea");
					ta.value = text;
					ta.className = "pickpen-clipboard-fallback";
					document.body.appendChild(ta);
					ta.select();
					const done = document.execCommand("copy");
					document.body.removeChild(ta);
					return done;
				};
				const copied = (await ok()) || fallback();
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
					n.noticeEl?.addClass("pickpen-notice-alert");
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

	// renderStatusCard 状态卡片：状态点 + 单行文案（class 由 deriveStatus 决定）
	private renderStatusCard(containerEl: HTMLElement): void {
		const card = containerEl.createDiv({ cls: "pickpen-status-card" });
		this.statusCardEl = card;
		this.statusDotEl = card.createDiv({ cls: "pickpen-status-dot" });
		this.statusTextEl = card.createDiv({ cls: "pickpen-status-text" });
		this.refreshStatusCard();
	}

	// refreshStatusCard 就地更新卡片 DOM（订阅回调；绝不重绘整页）
	private refreshStatusCard(): void {
		if (!this.statusCardEl) return;
		const s = deriveStatus(this.plugin.settings, syncState);
		this.statusCardEl.setAttribute("class", `pickpen-status-card is-${s.mod}`);
		this.statusTextEl!.textContent = s.text;
	}
}

// deriveStatus 状态判定（优先级：未登录 → 暂停 → 出错 → 受阻 → 同步中 → 已全部同步）
function deriveStatus(settings: PluginSettings, state: SyncState): { mod: string; text: string } {
	if (!settings.accessToken) return { mod: "yellow", text: "未登录：登录后开始同步" };
	if (state.pausedReason) return { mod: "yellow", text: `已暂停：${state.pausedReason}` };
	if (state.storageLimitExceeded) return { mod: "red", text: "同步已暂停：云端存储已满" };
	if (state.lastError) return { mod: "red", text: `同步出错：${state.lastError}` };
	if (state.blockedPaths.length > 0) return { mod: "yellow", text: `同步受阻：${state.blockedPaths.length} 个文件被阻塞（超限/冲突）` };
	if (state.sessionRunning) return { mod: "syncing", text: "同步中…：正在同步本地变更" };
	return { mod: "green", text: "已全部同步" };
}

// loginErrorMessage 登录错误分类：11001 邮箱格式错误 → 11003 验证码错误 → 其余按网络不可达
function loginErrorMessage(err: unknown): string {
	switch (errorCode(err)) {
		case ErrCode.InvalidCredentials:
			return "登录失败：邮箱或验证码格式错误";
		case ErrCode.InvalidOrExpiredCode:
			return "登录失败：验证码错误或已过期";
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

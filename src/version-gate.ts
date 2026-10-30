// 版本升级弹窗（强制 / 软提醒共用一套实现）：
// - force：不可关闭（close() 门闩 + 拦截 Esc/遮罩/返回手势），只能「前往更新」或「重新检查」；
// - soft：可正常关闭，提供「前往更新」与「忽略此版本」，忽略后该版本不再弹。
// 两种情况都不影响同步：弹窗只负责把升级路径摆到用户面前。

import { Modal, Notice, Setting } from "obsidian";

import type PickpenPlugin from "./index";
import { openCommunityPluginPage } from "./system-settings";
import type { VersionModalMode } from "./version-check";

export type { VersionModalMode };

export interface VersionModalOptions {
	mode: VersionModalMode;
	currentVersion: string;
	/** 服务端要求的目标版本（强制档为最低支持版本，软提醒为最新版本） */
	targetVersion: string;
	/** 该档位对应的升级说明（纯文本，可能含换行）；空串表示不展示 */
	notes: string;
	/** 重新检查版本（仅强制档）；弹窗保持打开，由插件决定是否关闭 */
	onRecheck: () => void;
	/** 忽略此版本（仅软提醒）：由插件持久化去重标记并关闭弹窗 */
	onIgnore: () => void;
	onClosed: () => void;
}

export class VersionGateModal extends Modal {
	private readonly plugin: PickpenPlugin;
	private readonly options: VersionModalOptions;
	private allowClose: boolean;

	constructor(plugin: PickpenPlugin, options: VersionModalOptions) {
		super(plugin.app);
		this.plugin = plugin;
		this.options = options;
		// 软提醒可正常关闭（关闭 = 稍后再说，不落「已忽略」标记）
		this.allowClose = options.mode === "soft";
		this.modalEl.classList.add("pickpen-version-modal");
		if (options.mode === "force") this.modalEl.classList.add("pickpen-version-gate-modal");
	}

	/** markClosable 放行关闭：仅版本已满足、用户忽略、或插件卸载时调用 */
	markClosable(): void {
		this.allowClose = true;
	}

	/**
	 * close 门闩：强制档下 Esc、点遮罩、右上角按钮、宿主内部的 close() 调用都会走到这里，
	 * 未放行时一律忽略——这是「不可关闭」的唯一权威防线，其余拦截只避免闪烁。
	 */
	override close(): void {
		if (!this.allowClose) return;
		super.close();
	}

	/** 移动端返回手势 / 桌面导航历史：强制档吞掉，软提醒沿用宿主默认关闭行为 */
	override onHistoryBack(): void {
		if (this.options.mode === "force") return;
		super.onHistoryBack();
	}

	onOpen(): void {
		if (this.options.mode === "force") {
			// 关闭按钮只是观感问题（真防线是 close 门闩），DOM 移除与 CSS 隐藏双保险
			this.modalEl.querySelector(".modal-close-button")?.remove();
			this.containerEl.addEventListener("keydown", this.blockEscape, true);
			this.containerEl.addEventListener("mousedown", this.blockBackdrop, true);
			this.containerEl.addEventListener("click", this.blockBackdrop, true);
		}
		const forced = this.options.mode === "force";
		this.setTitle(forced ? "请升级 Pickpen Sync" : "Pickpen Sync 有新版本");
		this.contentEl.createDiv({
			cls: "pickpen-version-message",
			text: forced
				? `当前版本 ${this.options.currentVersion} 已不再受支持，需要升级到 ${this.options.targetVersion}。`
				: `当前版本 ${this.options.currentVersion}，最新版本 ${this.options.targetVersion}。`,
		});

		// 升级说明：纯文本原样展示（保留换行），空串/纯空白不创建区块
		const notes = this.options.notes.trim();
		if (notes !== "") {
			this.contentEl.createDiv({ cls: "pickpen-version-description", text: notes });
		}

		const steps = this.contentEl.createEl("ol", { cls: "pickpen-version-steps" });
		steps.createEl("li", { text: "点击下方「前往更新」，打开本插件的详情页" });
		steps.createEl("li", { text: "在详情页点击「更新」" });
		steps.createEl("li", { text: "更新完成后按提示重新加载插件" });

		const actions = new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText("前往更新")
				.setCta()
				.onClick(() => {
					const opened = openCommunityPluginPage(this.plugin.app, this.plugin.manifest.id);
					if (!opened) {
						new Notice("无法自动打开插件详情页：请打开「设置 → 第三方插件」手动检查更新。");
						return;
					}
					// 软提醒可关闭：跳过去更新时收起弹窗（未点「忽略」,下次检查仍会提醒）。
					// 强制档保持打开，确保用户不会在未升级时回到主界面。
					if (this.options.mode === "soft") this.close();
				}),
		);
		if (forced) {
			actions.addButton((button) => button.setButtonText("重新检查").onClick(() => this.options.onRecheck()));
		} else {
			actions.addButton((button) => button.setButtonText("忽略此版本").onClick(() => this.options.onIgnore()));
		}
	}

	onClose(): void {
		if (this.options.mode === "force") {
			this.containerEl.removeEventListener("keydown", this.blockEscape, true);
			this.containerEl.removeEventListener("mousedown", this.blockBackdrop, true);
			this.containerEl.removeEventListener("click", this.blockBackdrop, true);
		}
		this.contentEl.empty();
		this.options.onClosed();
	}

	/** Escape：拦在容器捕获阶段，避免宿主 keymap 触发其它关闭动作（仅强制档） */
	private readonly blockEscape = (event: KeyboardEvent): void => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	/** 点击遮罩或容器空白处：阻止「点外部关闭」，也避免事件穿透到主界面（仅强制档） */
	private readonly blockBackdrop = (event: MouseEvent): void => {
		const target = event.target as Node | null;
		if (target && this.modalEl.contains(target)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	};
}

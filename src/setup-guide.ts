// 首次使用引导：用户启用插件后，主动把「登录 → 绑定仓库」这条路径摆到面前。
// 触发点是宿主在用户点击启用那一刻回调的 onUserEnable（冷启动不会触发），
// 因此不需要任何持久化标记即可保证只打扰一次。

import { App, Modal, Setting } from "obsidian";

import type { PluginSettings } from "./types";

export type SetupStage = "login" | "bind";

/** setupStage 当前配置阶段：未登录优先（没有账号时选择仓库没有意义） */
export function setupStage(settings: Pick<PluginSettings, "accessToken" | "vaultId">): SetupStage | null {
	if (!settings.accessToken) return "login";
	if (!settings.vaultId) return "bind";
	return null;
}

export interface SetupGuideCallbacks {
	/** 主按钮：是否关闭弹窗由调用方决定（打开设置失败时保留，用户仍可选「稍后」） */
	onPrimary: () => void;
	onClosed: () => void;
}

export class SetupGuideModal extends Modal {
	private readonly stage: SetupStage;
	private readonly callbacks: SetupGuideCallbacks;

	constructor(app: App, stage: SetupStage, callbacks: SetupGuideCallbacks) {
		super(app);
		this.stage = stage;
		this.callbacks = callbacks;
		this.modalEl.classList.add("pickpen-setup-guide-modal");
	}

	onOpen(): void {
		const { contentEl } = this;
		const login = this.stage === "login";
		this.setTitle(login ? "欢迎使用 Pickpen Sync" : "选择要绑定的仓库");

		if (login) {
			contentEl.createDiv({
				cls: "pickpen-setup-guide-message",
				text: "Pickpen Sync 会把笔记同步到你账号下的仓库，多台设备共用同一份内容。开始前需要先登录，首次登录会自动注册，只需邮箱验证码。",
			});
			const steps = contentEl.createEl("ol", { cls: "pickpen-setup-guide-steps" });
			steps.createEl("li", { text: "用邮箱验证码登录账号" });
			steps.createEl("li", { text: "选择要同步的仓库" });
			steps.createEl("li", { text: "之后的改动自动同步" });
		} else {
			contentEl.createDiv({
				cls: "pickpen-setup-guide-message",
				text: "账号已登录，还差最后一步。选择要同步的仓库后，本地笔记会与该仓库保持一致。",
			});
		}

		new Setting(contentEl)
			.setName("下一步")
			.addButton((button) => button.setButtonText("稍后").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(login ? "去登录" : "选择仓库")
					.setCta()
					.onClick(() => this.callbacks.onPrimary()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.callbacks.onClosed();
	}
}

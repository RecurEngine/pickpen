// 云端存储已满提醒：首次/跨日主动弹窗，Ribbon 红点提供持续入口。

import { Modal, Platform, Setting } from "obsidian";

import type PickpenPlugin from "./index";

/** 本地日期键用于“同一天最多主动提醒一次”，不受 UTC 跨日影响。 */
export function localDateKey(now = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export class StorageLimitModal extends Modal {
	private readonly onUpgrade: () => void;
	private readonly onClosed: () => void;

	constructor(plugin: PickpenPlugin, onUpgrade: () => void, onClosed: () => void) {
		super(plugin.app);
		this.onUpgrade = onUpgrade;
		this.onClosed = onClosed;
		this.modalEl.classList.add("pickpen-storage-limit-modal");
	}

	onOpen(): void {
		this.setTitle("Pickpen Sync 云端存储已满");
		this.contentEl.createDiv({
			cls: "pickpen-storage-limit-message",
			text: "新改动暂时无法上传，但本地笔记不会丢失。扩充容量后，Pickpen Sync 会自动恢复同步。",
		});

		const actions = new Setting(this.contentEl).setName("处理方式");
		if (Platform.isDesktopApp) {
			actions
				.setDesc("升级套餐可获得更多云端存储空间。")
				.addButton((button) => button.setButtonText("稍后处理").onClick(() => this.close()))
				.addButton((button) =>
					button
						.setButtonText("升级容量")
						.setCta()
						.onClick(() => {
							this.close();
							this.onUpgrade();
						}),
				);
		} else {
			actions
				.setDesc("请在桌面端 Obsidian 的 Pickpen Sync 设置中升级套餐。")
				.addButton((button) => button.setButtonText("知道了").setCta().onClick(() => this.close()));
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed();
	}
}

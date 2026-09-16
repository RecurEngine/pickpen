// 「查看密码」弹窗：把本机留存的仓库密码明文展示出来，便于用户抄录/复制。
// 只读展示，不做任何校验；调用方负责判断当前是否允许查看（已解锁且本机持有密码）。

import { App, Modal, Notice, Setting } from "obsidian";

export function showVaultPassword(app: App, password: string): void {
	new PasswordViewModal(app, password).open();
}

class PasswordViewModal extends Modal {
	constructor(
		app: App,
		private readonly password: string,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("仓库密码");
		this.contentEl.createEl("p", {
			text: "以下是本设备留存的该仓库密码，可复制后妥善保存。",
			cls: "pickpen-vault-message",
		});
		this.contentEl.createDiv({ cls: "pickpen-password-value", text: this.password });

		const buttons = new Setting(this.contentEl);
		buttons.addButton((btn) =>
			btn.setButtonText("复制").setCta().onClick(() => void this.copy()),
		);
		buttons.addButton((btn) => btn.setButtonText("关闭").onClick(() => this.close()));
	}

	private async copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(this.password);
			new Notice("仓库密码已复制");
		} catch {
			new Notice("复制失败，请手动选中密码后复制");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

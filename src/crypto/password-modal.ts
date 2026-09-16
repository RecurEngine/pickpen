// 仓库密码输入弹窗（解锁 / 新建加密仓库 / 转换 / 修改密码共用）。
// 密码只在本进程内使用：解出内容密钥后不写任何日志；是否在本机留存由「在本设备记住仓库密码」开关决定。

import { App, Modal, Platform, setIcon, Setting, setTooltip, TextComponent } from "obsidian";

/** 新设密码的长度范围。只约束「新设密码」，核验既有密码时不设限（见 submit）。 */
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 128;

export interface PasswordPromptOptions {
	title: string;
	description: string;
	submitLabel: string;
	/** 需再次输入确认（新建密码 / 修改密码时用）。同时是「本次是新设密码」的判据：只有此时才校验长度 */
	confirm?: boolean;
	/** 显示「在本设备记住仓库密码」开关；不给则不显示，此时 onSubmit 的第二参恒为 false */
	remember?: { initial: boolean };
	/** 返回错误文案则保留弹窗并展示，返回 null 表示成功 */
	onSubmit: (password: string, remember: boolean) => Promise<string | null>;
}

/**
 * 打开密码弹窗。用户自行取消时返回 false；提交成功返回 true。
 * 回调里抛出的异常按其 message 展示，不会关闭弹窗，便于用户重输。
 */
export function requestPassword(app: App, options: PasswordPromptOptions): Promise<boolean> {
	return new Promise((resolve) => {
		new PasswordModal(app, options, resolve).open();
	});
}

class PasswordModal extends Modal {
	private settled = false;
	private password = "";
	private confirmation = "";
	private remember = false;

	constructor(
		app: App,
		private readonly options: PasswordPromptOptions,
		private readonly done: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.options.title);
		// 长度要求并进这段描述，而不是挂成某一行的 desc：两行的 .setting-item-info 宽度必须一致，
		// 否则 .setting-item-control 分到的宽度不同，两个输入框就会一宽一窄
		const description = this.options.confirm
			? `${this.options.description}密码长度 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位。`
			: this.options.description;
		this.contentEl.createEl("p", { text: description, cls: "pickpen-vault-message" });

		this.addPasswordRow("仓库密码", (value) => (this.password = value), { focus: true });

		if (this.options.confirm) {
			this.addPasswordRow("确认密码", (value) => (this.confirmation = value));
		}

		if (this.options.remember) {
			this.remember = this.options.remember.initial;
			new Setting(this.contentEl)
				.setName("在本设备记住仓库密码")
				.setDesc(
					"开启后重启本设备无需再次输入，可直接从仓库管理里查看密码；密码与内容密钥只保存在本机，不随 vault 同步。" +
						"共用该设备的他人可解密仓库内容，请谨慎开启。",
				)
				.addToggle((toggle) =>
					toggle.setValue(this.remember).onChange((value) => {
						this.remember = value;
					}),
				);
		}

		this.errorEl = this.contentEl.createDiv({ cls: "pickpen-vault-message is-error" });
		this.errorEl.hide();

		const buttons = new Setting(this.contentEl);
		buttons.addButton((btn) =>
			btn.setButtonText(this.options.submitLabel).setCta().onClick(() => void this.submit()),
		);
		buttons.addButton((btn) => btn.setButtonText("取消").onClick(() => this.close()));
	}

	private errorEl?: HTMLElement;

	// 一行密码输入：右侧内嵌眼睛图标按钮，点击在明文/密文之间切换。
	// 只改 inputEl.type，不重建 DOM——重建会丢掉用户已输入的内容。
	private addPasswordRow(
		name: string,
		onChange: (value: string) => void,
		options?: { focus?: boolean },
	): void {
		const setting = new Setting(this.contentEl).setName(name);
		// 必须自带 wrapper：Setting#addText 会把 input 直接塞进 controlEl（flex 行），没有容器可托住内嵌图标
		const field = setting.controlEl.createDiv({ cls: "pickpen-password-field" });
		const text = new TextComponent(field);
		const inputEl = text.inputEl;
		inputEl.type = "password";
		inputEl.autocomplete = "off";
		inputEl.addClass("pickpen-password-input");
		text.onChange(onChange);
		inputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") void this.submit();
		});
		// 绕过 addText 会丢掉它移动端的「回车收键盘」，这里补回，保持行为一致
		if (Platform.isMobile) {
			inputEl.addEventListener("keydown", (evt) => {
				if (!evt.isComposing && !evt.defaultPrevented && evt.key === "Enter") inputEl.blur();
			});
		}

		let visible = false;
		// clickable-icon 是 Obsidian 图标按钮的约定类：button:not(.clickable-icon) 的填充底色与内阴影不会落到它身上
		const toggle = field.createEl("button", {
			cls: "clickable-icon pickpen-password-toggle",
			attr: { type: "button" },
		});
		const syncToggle = (): void => {
			setIcon(toggle, visible ? "eye-off" : "eye");
			// setTooltip 会一并写入 aria-label，图标按钮的无障碍名称就来自这里
			setTooltip(toggle, visible ? "隐藏密码" : "显示密码");
		};
		syncToggle();
		// 按下即阻止默认行为：不让按钮抢走输入框焦点与光标位置
		toggle.addEventListener("mousedown", (evt) => evt.preventDefault());
		toggle.addEventListener("click", () => {
			const caret = inputEl.selectionStart;
			visible = !visible;
			// 切 type 不丢 value，但浏览器会在点击默认行为收尾时把光标重置到 0；
			// 恢复必须延到下一拍，在 handler 内同步 setSelectionRange 会被覆盖
			inputEl.type = visible ? "text" : "password";
			syncToggle();
			inputEl.focus();
			if (caret !== null) window.setTimeout(() => inputEl.setSelectionRange(caret, caret), 0);
		});

		if (options?.focus) window.setTimeout(() => inputEl.focus(), 0);
	}

	private showError(message: string): void {
		if (!this.errorEl) return;
		this.errorEl.setText(message);
		this.errorEl.show();
	}

	private async submit(): Promise<void> {
		if (this.errorEl) this.errorEl.hide();
		if (!this.password) {
			this.showError("请输入仓库密码");
			return;
		}
		// 以下校验只针对新设密码。解锁与「修改密码」第一步是在核验既有密码，
		// 在那里设限会让早于本规则创建的短密码再也解不开自己的仓库。
		if (this.options.confirm) {
			if (this.password.length < PASSWORD_MIN_LENGTH) {
				this.showError(`密码长度不能少于 ${PASSWORD_MIN_LENGTH} 位`);
				return;
			}
			if (this.password.length > PASSWORD_MAX_LENGTH) {
				this.showError(`密码长度不能超过 ${PASSWORD_MAX_LENGTH} 位`);
				return;
			}
			if (this.confirmation !== this.password) {
				this.showError("两次输入的密码不一致");
				return;
			}
		}
		try {
			const error = await this.options.onSubmit(this.password, this.remember);
			if (error) {
				this.showError(error);
				return;
			}
			this.settled = true;
			this.close();
		} catch (err) {
			this.showError(err instanceof Error ? err.message : "操作失败，请重试");
		}
	}

	onClose(): void {
		this.password = "";
		this.confirmation = "";
		this.contentEl.empty();
		if (!this.settled) this.done(false);
		else this.done(true);
	}
}

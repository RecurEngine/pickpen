// 需要排除的文件夹 [管理]（specs/sync/spec.md 需求 1）：列表 + 添加选择器 + 行内删除。
// 排除按整棵子树生效（目录自身与其下所有路径都不再参与同步），与同步范围的过滤口径一致。

import { App, ButtonComponent, Modal, Notice, Platform, TFolder } from "obsidian";

import type PickpenPlugin from "./index";
import { normalize } from "./excludes";

// openFolderExclusionManager 打开排除文件夹管理弹窗；onChange 在清单变化后回调（供设置页重渲染）
export function openFolderExclusionManager(app: App, plugin: PickpenPlugin, onChange?: () => void): void {
	new FolderExclusionModal(app, plugin, onChange).open();
}

class FolderExclusionModal extends Modal {
	private plugin: PickpenPlugin;
	private onChange?: () => void;
	private listEl!: HTMLElement;
	private pickerEl!: HTMLElement;

	constructor(app: App, plugin: PickpenPlugin, onChange?: () => void) {
		super(app);
		this.plugin = plugin;
		this.onChange = onChange;
		this.modalEl.classList.add("pickpen-exclude-modal");
		if (Platform.isMobile) this.modalEl.classList.add("is-mobile");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		const header = contentEl.createDiv({ cls: "pickpen-vault-header" });
		header.createEl("h3", { text: "需要排除的文件夹" });
		contentEl.createDiv({
			cls: "setting-item-description pickpen-vault-desc",
			text: "被排除的文件夹及其子文件夹都不会被同步（含已有的和之后新建的）。",
		});
		this.pickerEl = contentEl.createDiv({ cls: "pickpen-exclude-picker" });
		this.listEl = contentEl.createDiv({ cls: "pickpen-vault-list" });
		this.renderPicker();
		this.renderList();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** 添加选择器：列出当前 vault 的文件夹（已被排除的不重复出现） */
	private renderPicker(): void {
		this.pickerEl.empty();
		const excluded = new Set(this.plugin.settings.selective.excludedFolders);
		const candidates = this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path !== "/")
			.map((f) => normalize(f.path))
			.filter((path) => !excluded.has(path) && !this.isCovered(path, excluded))
			.sort((a, b) => a.localeCompare(b, "zh-CN"));

		if (candidates.length === 0) {
			this.pickerEl.createDiv({ cls: "pickpen-vault-message", text: "没有可添加的文件夹" });
			return;
		}
		const select = this.pickerEl.createEl("select", { cls: "dropdown" });
		select.createEl("option", { text: "选择要排除的文件夹…", value: "" });
		for (const path of candidates) select.createEl("option", { text: path, value: path });
		new ButtonComponent(this.pickerEl)
			.setButtonText("添加")
			.onClick(async () => {
				if (!select.value) {
					new Notice("请先选择文件夹");
					return;
				}
				await this.add(select.value);
			});
	}

	/** path 是否已被某个已排除的祖先覆盖（无需重复添加） */
	private isCovered(path: string, excluded: Set<string>): boolean {
		const segs = path.split("/");
		for (let i = 1; i < segs.length; i++) {
			if (excluded.has(segs.slice(0, i).join("/"))) return true;
		}
		return false;
	}

	private async add(path: string): Promise<void> {
		const folders = this.plugin.settings.selective.excludedFolders;
		if (folders.includes(path)) return;
		folders.push(path);
		folders.sort((a, b) => a.localeCompare(b, "zh-CN"));
		await this.commit();
		this.renderPicker();
		this.renderList();
	}

	private async remove(path: string): Promise<void> {
		const folders = this.plugin.settings.selective.excludedFolders;
		const idx = folders.indexOf(path);
		if (idx < 0) return;
		folders.splice(idx, 1);
		await this.commit();
		this.renderPicker();
		this.renderList();
	}

	/** 落盘并强制重算：排除项变化会改变本轮同步范围，等不到自然重扫 */
	private async commit(): Promise<void> {
		await this.plugin.saveSettings();
		this.plugin.session.requestRun({ forceAudit: true });
		this.onChange?.();
	}

	private renderList(): void {
		this.listEl.empty();
		const folders = this.plugin.settings.selective.excludedFolders;
		if (folders.length === 0) {
			this.listEl.createDiv({ cls: "pickpen-vault-message", text: "未添加排除项。" });
			return;
		}
		for (const path of folders) {
			const row = this.listEl.createDiv({ cls: "pickpen-exclude-item" });
			row.createDiv({ cls: "pickpen-exclude-path", text: path });
			new ButtonComponent(row)
				.setButtonText("移除")
				.setDestructive()
				.onClick(() => void this.remove(path));
		}
	}
}

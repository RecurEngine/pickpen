// 文件历史版本（spec FR-16）：右键菜单「拾笔版本历史」/ 命令面板入口。
// HistoryModal：分页列出 file_version 历史 → 点选显示与当前文件的 diff 对比 → 行内确认「恢复此版本」
// （下载历史内容写回当前路径 → 刷新打开视图 → requestRun 触发同步上传为新版本，旧版本保留）。

import {
	ButtonComponent,
	Component,
	MarkdownRenderer,
	Modal,
	Notice,
	Platform,
	TFile,
	ToggleComponent,
} from "obsidian";

import { debugLog } from "./debug-log";
import type PickpenPlugin from "./index";
import { FileVersionState, type FileVersionInfo } from "./gen/proto/sync/sync.ext_pb";
import { isBlobNotReferenced, isUnauthenticated } from "./remote-connect";
import { normalize } from "./excludes";
import { diffTexts, type DiffLine } from "./history-diff";
import { captureOpenViews, refreshOpenViews } from "./view-sync";
import { toArrayBuffer, writeLocalFile } from "./sync/vault-io";
import type { Snapshot } from "./sync/types";

// resolveFileId 从 Base Snapshot 反查路径的 file_id（稳定 UUID，rename 不变；tombstone 同样携带）
export function resolveFileId(base: Snapshot | null, path: string): string | null {
	return base?.entries[path]?.file_id ?? null;
}

// formatHistoryTime 毫秒时间戳 → 本地时间（毫秒量级 1.7e12 远小于 Number 安全整数）
export function formatHistoryTime(ms: bigint): string {
	return new Date(Number(ms)).toLocaleString("zh-CN", { hour12: false });
}

// formatHistorySize 字节 → 人类可读（B/KB/MB）
export function formatHistorySize(size: bigint): string {
	if (size < 1024n) return `${size} B`;
	if (size < 1024n * 1024n) return `${(Number(size) / 1024).toFixed(1)} KB`;
	return `${(Number(size) / (1024 * 1024)).toFixed(1)} MB`;
}

// isBinaryContent 首 8KB 含 \x00 视为二进制（不可 Markdown 渲染，仍可恢复）
export function isBinaryContent(content: Uint8Array): boolean {
	const limit = Math.min(content.byteLength, 8192);
	for (let i = 0; i < limit; i++) {
		if (content[i] === 0) return true;
	}
	return false;
}

// installHistoryFeature 注册右键菜单「拾笔版本历史」与命令面板入口；
// 未登录/未绑定或文件不在 Base（未同步）时菜单项禁用并附标题提示
export function installHistoryFeature(plugin: PickpenPlugin): void {
	plugin.registerEvent(
		plugin.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile)) return; // 排除文件夹
			const bound = !!plugin.settings.accessToken && !!plugin.settings.vaultId;
			const fileId = resolveFileId(plugin.baseStore.getBase(), normalize(file.path));
			menu.addItem((item) => {
				item.setIcon("history");
				item.setTitle(
					!bound ? "拾笔版本历史（需先登录并绑定仓库）" : fileId ? "拾笔版本历史" : "拾笔版本历史（文件尚未同步）",
				);
				if (!bound || !fileId) {
					item.setDisabled(true);
					return;
				}
				item.onClick(() => openHistoryForFile(plugin, file));
			});
		}),
	);
	plugin.addCommand({
		id: "history-active-file",
		name: "查看当前文件的版本历史",
		callback: () => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file) {
				new Notice("请先打开一个文件");
				return;
			}
			openHistoryForFile(plugin, file);
		},
	});
}

// openHistoryForFile 历史弹窗入口（菜单/命令共用；命令入口需二次校验绑定与 file_id）
export function openHistoryForFile(plugin: PickpenPlugin, file: TFile): void {
	if (!plugin.settings.accessToken || !plugin.settings.vaultId) {
		new Notice("请先登录并绑定仓库");
		return;
	}
	const path = normalize(file.path);
	const fileId = resolveFileId(plugin.baseStore.getBase(), path);
	if (!fileId) {
		new Notice("该文件尚未同步，无法查看版本历史");
		return;
	}
	new HistoryModal(plugin, fileId, path, file.path).open();
}

const PAGE_SIZE = 50;

class HistoryModal extends Modal {
	private readonly plugin: PickpenPlugin;
	private readonly fileId: string;
	private readonly currentPath: string; // normalize 后的右键路径（恢复写回目标）
	private readonly displayPath: string; // 原始路径（展示）

	private versions: FileVersionInfo[] = [];
	private pageToken = "";
	private hasMore = false;
	private loading = false;
	private selected: FileVersionInfo | null = null;
	private closed = false;
	private restoring = false;
	private selectionGeneration = 0;
	private renderGeneration = 0;
	private selectedContent: Uint8Array | null = null;
	private selectedText: string | null = null;
	private selectedBinary = false;
	private currentText = "";
	private currentLoaded = false;
	private currentBinary = false;
	private currentMissing = false;
	private showDiff = false;
	private markdownComponent: Component | null = null;

	private listEl!: HTMLElement;
	private previewHeadEl!: HTMLElement;
	private restoreRowEl!: HTMLElement;
	private previewBodyEl!: HTMLElement;
	private mobileMainEl!: HTMLElement;
	private diffToggle: ToggleComponent | null = null;
	private copyButton: ButtonComponent | null = null;
	private restoreButton: ButtonComponent | null = null;

	constructor(plugin: PickpenPlugin, fileId: string, currentPath: string, displayPath: string) {
		super(plugin.app);
		this.plugin = plugin;
		this.fileId = fileId;
		this.currentPath = currentPath;
		this.displayPath = displayPath;
		this.modalEl.classList.add("pickpen-history-modal");
		if (Platform.isMobile) this.modalEl.classList.add("is-mobile");
	}

	async onOpen(): Promise<void> {
		if (Platform.isMobile) {
			await this.openMobile();
			return;
		}
		const { contentEl } = this;
		contentEl.empty();
		// 标题行：h3 与「刷新」同行
		const header = contentEl.createDiv({ cls: "pickpen-history-header" });
		header.createEl("h3", { text: `版本历史：${this.displayPath.split("/").pop()}` });
		new ButtonComponent(header)
			.setButtonText("刷新")
			.onClick(() => {
				this.versions = [];
				this.pageToken = "";
				void this.loadVersions(true);
			});
		contentEl.createDiv({ cls: "pickpen-history-path", text: this.displayPath });
		// 双栏：左列表 / 右预览
		const split = contentEl.createDiv({ cls: "pickpen-history-split" });
		const listPane = split.createDiv({ cls: "pickpen-history-list-pane" });
		this.listEl = listPane.createDiv({ cls: "pickpen-history-list" });
		const previewPane = split.createDiv({ cls: "pickpen-history-pane" });
		this.previewHeadEl = previewPane.createDiv({ cls: "pickpen-history-preview-head" });
		this.restoreRowEl = previewPane.createDiv({ cls: "pickpen-history-restore" });
		this.previewBodyEl = previewPane.createDiv({ cls: "pickpen-history-preview-body markdown-preview-view" });
		this.previewHeadEl.createDiv({ cls: "pickpen-vault-message", text: "选择左侧版本查看内容" });
		await this.loadVersions(true);
	}

	onClose(): void {
		this.closed = true;
		this.selectionGeneration++;
		this.renderGeneration++;
		this.disposeMarkdown();
		this.versions = [];
		const { contentEl } = this;
		contentEl.empty();
	}

	// openMobile 移动端使用列表/详情两级页面；右上角关闭按钮沿用 Obsidian Modal 原生控件。
	private async openMobile(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pickpen-history-mobile-content");
		this.setTitle(this.mobileTitle());
		const header = this.titleEl.parentElement;
		if (!header) throw new Error("版本历史弹窗缺少标题栏");
		header.addClass("pickpen-history-mobile-header");
		this.mobileMainEl = contentEl.createDiv({ cls: "pickpen-history-mobile-main" });
		this.renderMobileListScreen();
		await this.loadVersions(true);
	}

	private mobileTitle(): string {
		const filename = this.displayPath.split("/").pop() ?? this.displayPath;
		const dot = filename.lastIndexOf(".");
		return dot > 0 ? filename.slice(0, dot) : filename;
	}

	private renderMobileListScreen(): void {
		this.mobileMainEl.empty();
		this.mobileMainEl.removeClass("is-detail");
		this.listEl = this.mobileMainEl.createDiv({ cls: "pickpen-history-list is-mobile" });
		if (this.loading && this.versions.length === 0) {
			this.renderLoading(this.listEl, "正在加载版本历史…");
		} else if (this.versions.length > 0) {
			this.renderList();
		}
	}

	private resetSelectedContent(): void {
		this.selectedContent = null;
		this.selectedText = null;
		this.selectedBinary = false;
		this.currentText = "";
		this.currentLoaded = false;
		this.currentBinary = false;
		this.currentMissing = false;
		this.showDiff = false;
		this.diffToggle = null;
		this.copyButton = null;
		this.restoreButton = null;
	}

	private renderMobileDetailScreen(v: FileVersionInfo): void {
		this.mobileMainEl.empty();
		this.mobileMainEl.addClass("is-detail");

		const actions = this.mobileMainEl.createDiv({ cls: "pickpen-history-mobile-actions" });
		const diffSetting = actions.createDiv({ cls: "pickpen-history-diff-setting pickpen-history-mobile-diff-setting" });
		diffSetting.createSpan({ text: "显示差异" });
		this.diffToggle = new ToggleComponent(diffSetting)
			.setValue(false)
			.setDisabled(true)
			.onChange((value) => {
				this.showDiff = value;
				void this.renderSelectedContent();
			});
		this.copyButton = new ButtonComponent(actions)
			.setButtonText("复制")
			.setDisabled(true)
			.onClick(() => void this.copySelectedText());
		this.restoreButton = new ButtonComponent(actions)
			.setButtonText("恢复此版本")
			.setDisabled(true)
			.onClick(() => this.renderRestoreConfirmation(v));

		this.restoreRowEl = this.mobileMainEl.createDiv({ cls: "pickpen-history-restore is-mobile" });
		this.previewHeadEl = this.mobileMainEl.createDiv({ cls: "pickpen-history-preview-head is-mobile" });
		this.previewBodyEl = this.mobileMainEl.createDiv({ cls: "pickpen-history-preview-body is-mobile markdown-preview-view" });
	}

	private renderDesktopActions(v: FileVersionInfo): void {
		this.restoreRowEl.empty();
		this.restoreRowEl.addClass("pickpen-history-desktop-actions");
		const diffSetting = this.restoreRowEl.createDiv({ cls: "pickpen-history-diff-setting" });
		diffSetting.createSpan({ text: "显示差异" });
		this.diffToggle = new ToggleComponent(diffSetting)
			.setValue(this.showDiff)
			.setDisabled(true)
			.onChange((value) => {
				this.showDiff = value;
				void this.renderSelectedContent();
			});
		this.copyButton = new ButtonComponent(this.restoreRowEl)
			.setButtonText("复制")
			.setDisabled(true)
			.onClick(() => void this.copySelectedText());
		this.restoreButton = new ButtonComponent(this.restoreRowEl)
			.setButtonText("恢复此版本")
			.setDisabled(true)
			.onClick(() => this.renderRestoreConfirmation(v));
		this.updateActions(false);
	}

	private async selectVersion(v: FileVersionInfo, mobile: boolean): Promise<void> {
		if (this.restoring) return;
		this.selectionGeneration++;
		const generation = this.selectionGeneration;
		this.disposeMarkdown();
		this.resetSelectedContent();
		this.selected = v;
		if (mobile) {
			this.renderMobileDetailScreen(v);
		} else {
			this.renderPreviewHead(v);
			this.renderDesktopActions(v);
		}
		this.previewBodyEl.empty();
		if (!v.contentHash) {
			this.previewBodyEl.createDiv({ cls: "pickpen-vault-message", text: "该版本无内容" });
			return;
		}

		this.renderLoading(this.previewBodyEl, "正在加载版本内容…");
		let content: Uint8Array;
		try {
			content = await this.plugin.remote.getBlob(v.contentHash, 0n, "", v.fileId);
		} catch (err) {
			if (!this.isCurrentSelection(v, generation)) return;
			this.previewBodyEl.empty();
			this.previewBodyEl.createDiv({ cls: "pickpen-vault-message is-error", text: this.previewErrorText(err) });
			return;
		}
		if (!this.isCurrentSelection(v, generation)) return;

		this.selectedContent = content;
		this.selectedBinary = isBinaryContent(content);
		if (!this.selectedBinary) this.selectedText = new TextDecoder("utf-8").decode(content);
		this.updateActions(false);
		await this.renderSelectedContent();
	}

	private isCurrentSelection(v: FileVersionInfo, generation: number): boolean {
		return !this.closed && this.selected === v && this.selectionGeneration === generation;
	}

	private updateActions(busy: boolean): void {
		const hasContent = this.selectedContent !== null;
		const textReady = hasContent && !this.selectedBinary;
		this.diffToggle?.setDisabled(busy || !textReady);
		this.copyButton?.setDisabled(busy || !textReady);
		this.restoreButton?.setDisabled(busy || !hasContent);
	}

	private async copySelectedText(): Promise<void> {
		if (this.selectedText === null || this.restoring) return;
		try {
			await navigator.clipboard.writeText(this.selectedText);
			new Notice("已复制该版本内容");
		} catch (err) {
			debugLog.error("[pickpen] 复制历史版本失败", err);
			new Notice("复制失败，请重试");
		}
	}

	private renderRestoreConfirmation(v: FileVersionInfo): void {
		if (!this.selectedContent || this.restoring) return;
		this.restoreRowEl.empty();
		this.restoreRowEl.createDiv({
			cls: "pickpen-history-confirm-text",
			text: Platform.isMobile
				? "将用此版本覆盖当前文件，历史版本会保留。确认？"
				: `将用此版本内容覆盖当前文件（${this.displayPath}），历史版本保留。确认？`,
		});
		new ButtonComponent(this.restoreRowEl)
			.setButtonText("确认恢复")
			.setWarning()
			.setCta()
			.onClick(() => void this.restore(v, this.selectedContent ?? undefined));
		new ButtonComponent(this.restoreRowEl)
			.setButtonText("取消")
			.onClick(() => {
				if (Platform.isMobile) this.restoreRowEl.empty();
				else this.renderDesktopActions(v);
			});
	}

	private async renderSelectedContent(): Promise<void> {
		const v = this.selected;
		if (!v || this.selectedContent === null) return;
		const generation = ++this.renderGeneration;
		this.disposeMarkdown();
		this.previewBodyEl.empty();
		if (Platform.isMobile) this.previewHeadEl.empty();
		else this.renderPreviewHead(v);

		if (this.selectedBinary || this.selectedText === null) {
			this.previewBodyEl.createDiv({ cls: "pickpen-vault-message", text: "二进制内容，无法预览（仍可恢复）" });
			return;
		}
		if (!this.showDiff) {
			const target = document.createElement("div");
			target.addClass("markdown-preview-sizer", "markdown-preview-section");
			const component = new Component();
			component.load();
			try {
				await MarkdownRenderer.render(this.app, this.selectedText, target, this.currentPath, component);
			} catch (err) {
				component.unload();
				if (!this.isCurrentRender(v, generation)) return;
				this.previewBodyEl.createDiv({ cls: "pickpen-vault-message is-error", text: `Markdown 渲染失败：${String(err)}` });
				return;
			}
			if (!this.isCurrentRender(v, generation) || this.showDiff) {
				component.unload();
				return;
			}
			this.markdownComponent = component;
			this.previewBodyEl.appendChild(target);
			return;
		}

		if (!(await this.loadCurrentTextForDiff(v, generation))) return;
		if (this.currentBinary) {
			this.previewBodyEl.createDiv({
				cls: "pickpen-vault-message",
				text: "当前文件为二进制内容，无法对比（仍可恢复）",
			});
			return;
		}
		if (this.currentMissing) {
			this.previewHeadEl.createSpan({ text: "当前文件已删除，历史内容相对空文件显示为新增" });
		}
		renderDiff(this.previewBodyEl, diffTexts(this.selectedText, this.currentText));
	}

	private async loadCurrentTextForDiff(v: FileVersionInfo, generation: number): Promise<boolean> {
		if (this.currentLoaded) return this.isCurrentRender(v, generation);
		this.renderLoading(this.previewBodyEl, "正在生成差异…");
		const abs = this.app.vault.getAbstractFileByPath(this.currentPath);
		if (!abs) {
			this.currentMissing = true;
			this.currentLoaded = true;
			this.previewBodyEl.empty();
			return this.isCurrentRender(v, generation);
		}
		try {
			const current = new Uint8Array(await this.app.vault.adapter.readBinary(this.currentPath));
			if (!this.isCurrentRender(v, generation)) return false;
			this.currentBinary = isBinaryContent(current);
			if (!this.currentBinary) this.currentText = new TextDecoder("utf-8").decode(current);
			this.currentLoaded = true;
			this.previewBodyEl.empty();
			return true;
		} catch (err) {
			if (!this.isCurrentRender(v, generation)) return false;
			this.previewBodyEl.empty();
			this.previewBodyEl.createDiv({ cls: "pickpen-vault-message is-error", text: `读取当前文件失败：${String(err)}` });
			return false;
		}
	}

	private isCurrentRender(v: FileVersionInfo, generation: number): boolean {
		return !this.closed && this.selected === v && this.renderGeneration === generation;
	}

	private disposeMarkdown(): void {
		if (!this.markdownComponent) return;
		this.markdownComponent.unload();
		this.markdownComponent = null;
	}

	private renderLoading(container: HTMLElement, text: string): void {
		container.empty();
		const loading = container.createDiv({ cls: "pickpen-history-loading" });
		loading.createDiv({ cls: "pickpen-history-spinner", attr: { "aria-hidden": "true" } });
		loading.createSpan({ text });
	}

	// loadVersions 拉取一页历史（first = 首页全量重绘；否则追加）。防重入。
	private async loadVersions(first: boolean): Promise<void> {
		if (this.loading || this.closed) return;
		this.loading = true;
		if (first && this.versions.length === 0) this.renderLoading(this.listEl, "正在加载版本历史…");
		try {
			const resp = await this.plugin.remote.listFileVersions(this.fileId, PAGE_SIZE, this.pageToken);
			if (this.closed) return;
			if (first) this.versions = [];
			this.versions.push(...resp.versions);
			this.pageToken = resp.nextPageToken;
			this.hasMore = resp.hasMore;
			this.renderList();
		} catch (err) {
			if (this.closed) return;
			if (first) this.listEl.empty();
			if (isUnauthenticated(err)) {
				this.listEl.createDiv({ cls: "pickpen-vault-message is-error", text: "登录已失效，请重新登录" });
				return;
			}
			const e = err as { rawMessage?: string };
			const error = this.listEl.createDiv({ cls: "pickpen-history-load-error" });
			error.createDiv({ cls: "pickpen-vault-message is-error", text: `历史加载失败：${e.rawMessage ?? String(err)}` });
			new ButtonComponent(error).setButtonText("重试").onClick(() => void this.loadVersions(first));
		} finally {
			this.loading = false;
		}
	}

	// renderList 重绘列表（含「加载更多」行）
	private renderList(): void {
		this.listEl.empty();
		if (this.versions.length === 0) {
			this.listEl.createDiv({ cls: "pickpen-vault-message", text: "暂无历史版本" });
			return;
		}
		for (const v of this.versions) {
			this.renderItem(v, Platform.isMobile);
		}
		if (this.hasMore) {
			const more = this.listEl.createDiv({ cls: "pickpen-history-load-more" });
			const button = new ButtonComponent(more)
				.setButtonText("加载更多")
				.onClick((evt) => {
					const btn = evt.currentTarget as HTMLElement;
					btn.setAttribute("disabled", "");
					button.setButtonText("加载中…");
					void this.loadVersions(false).finally(() => {
						btn.removeAttribute("disabled");
						button.setButtonText("加载更多");
					});
				});
		}
	}

	// renderItem 单个版本行：时间/大小/状态徽标 + 当时路径（与当前路径不同时显示）
	private renderItem(v: FileVersionInfo, mobile = false): void {
		const isSelected = this.selected === v;
		const item = this.listEl.createDiv({
			cls: `pickpen-history-item${mobile ? " pickpen-history-mobile-item" : ""}${isSelected ? " is-selected" : ""}`,
		});
		const meta = item.createDiv({ cls: "pickpen-history-item-meta" });
		meta.createDiv({ cls: "pickpen-history-item-time", text: formatHistoryTime(v.createdAt) });
		meta.createDiv({ cls: "pickpen-history-item-size", text: formatHistorySize(v.size) });
		if (v.state === FileVersionState.FILE_VERSION_DELETED) {
			meta.createDiv({ cls: "pickpen-history-badge is-deleted", text: "已删除" });
		}
		if (v.path !== this.currentPath) {
			item.createDiv({ cls: "pickpen-history-item-path", text: `当时路径：${v.path}` });
		}
		item.addEventListener("click", () => {
			void this.selectVersion(v, mobile);
		});
	}

	// renderPreviewHead 预览头部元信息
	private renderPreviewHead(v: FileVersionInfo): void {
		this.previewHeadEl.empty();
		this.previewHeadEl.createSpan({ text: formatHistoryTime(v.createdAt) });
		this.previewHeadEl.createSpan({ text: `r${v.revision}` });
		this.previewHeadEl.createSpan({ text: formatHistorySize(v.size) });
		if (v.state === FileVersionState.FILE_VERSION_DELETED) {
			this.previewHeadEl.createSpan({ text: "已删除" });
		}
		if (v.path !== this.currentPath) {
			this.previewHeadEl.createSpan({ text: `当时路径：${v.path}` });
		}
	}


	// restore 恢复：下载全量 → 写盘（自动建父目录，覆盖「曾删除重建」）→ 刷新打开视图 → 触发同步
	private async restore(v: FileVersionInfo, cachedContent?: Uint8Array): Promise<void> {
		this.restoring = true;
		this.restoreRowEl.empty();
		if (Platform.isMobile) {
			this.updateActions(true);
			this.renderLoading(this.restoreRowEl, cachedContent ? "正在写回…" : "正在下载并写回…");
		} else {
			this.restoreRowEl.createDiv({ cls: "pickpen-history-confirm-text", text: "正在下载并写回…" });
		}
		let content = cachedContent;
		if (!content) {
			try {
				content = await this.plugin.remote.getBlob(v.contentHash, 0n, "", v.fileId);
			} catch (err) {
				this.restoring = false;
				if (isUnauthenticated(err)) {
					new Notice("登录已失效，请重新登录");
					this.close();
					return;
				}
				new Notice(`恢复失败：${this.previewErrorText(err)}`);
				this.resetRestoreUi(v);
				return;
			}
		}
		try {
			// 文件当前不存在（曾删除）→ vault.createBinary 重建并触发 create 事件（文件树刷新）；
			// 存在 → adapter 直写（与引擎写盘一致，不产生事件）
			if (this.app.vault.getAbstractFileByPath(this.currentPath)) {
				await writeLocalFile(this.app, this.currentPath, content);
			} else {
				await this.app.vault.createBinary(this.currentPath, toArrayBuffer(content));
			}
			const states = await captureOpenViews(this.app, this.currentPath);
			await refreshOpenViews(this.app, states, content, /* force */ true); // 恢复是显式确认操作，跳过快照规则
		} catch (err) {
			this.restoring = false;
			debugLog.error("[pickpen] 恢复写盘失败", err);
			new Notice("恢复写盘失败，请重试");
			this.resetRestoreUi(v);
			return;
		}
		// adapter 写盘不触发 vault 事件，必须显式传 dirtyPaths 才会被扫描上传
		this.plugin.session.requestRun({ dirtyPaths: new Set([this.currentPath]) });
		new Notice("已恢复该版本，正在同步…");
		this.close();
	}

	private resetRestoreUi(v: FileVersionInfo): void {
		if (Platform.isMobile) {
			this.restoreRowEl.empty();
			this.updateActions(false);
			return;
		}
		this.renderDesktopActions(v);
	}

	// previewErrorText 历史内容读取失败文案（12021 = 超保留期已清理）
	private previewErrorText(err: unknown): string {
		if (isBlobNotReferenced(err)) {
			return "该版本内容已超过 30 天保留期被清理，无法读取";
		}
		const e = err as { rawMessage?: string };
		return e.rawMessage ?? String(err);
	}
}

// renderDiff 行级 diff 渲染：+ 绿底 / − 红底 / 未变普通；行内高亮段深色；空行 ± 占位保持行高
function renderDiff(container: HTMLElement, lines: DiffLine[]): void {
	const box = container.createDiv({ cls: "pickpen-history-diff" });
	for (const line of lines) {
		const row = box.createDiv({
			cls: `pickpen-diff-line${line.type === "add" ? " is-add" : line.type === "del" ? " is-del" : ""}`,
		});
		row.createSpan({ cls: "pickpen-diff-gutter", text: line.type === "add" ? "+" : line.type === "del" ? "−" : "" });
		if (line.type === "same") {
			row.createSpan({ text: line.text });
		} else if (line.text === "") {
			row.createSpan({ text: "±" }); // 空行占位保持行高
		} else if (line.changes) {
			for (const c of line.changes) {
				const span = row.createSpan({ text: c.value });
				if (c.added) span.addClass("pickpen-diff-inner", "is-add");
				else if (c.removed) span.addClass("pickpen-diff-inner", "is-del");
			}
		} else {
			row.createSpan({ text: line.text });
		}
	}
}

// 已删除的文件（specs/sync/spec.md 需求 3）：列表 + 预览删除前内容 + 恢复到原路径。
// 数据源是服务端的删除记录（同一路径多次「删除 → 重建 → 再删除」各自独立成条，重命名不出现）；
// 列表只含保留期内的记录，与版本历史同一口径。
// 目录条目不提供预览与恢复（空目录没有内容可恢复）；加密仓库的列表本身无需解锁，
// 只有预览与恢复会要求先解锁。
// 列表/预览沿用版本历史弹窗的样式类与「桌面双栏 / 移动端两级页」结构（结构一致，不再写一套视觉规则）。

import { App, ButtonComponent, Component, MarkdownRenderer, Modal, Notice, Platform } from "obsidian";

import { openForLocal } from "./crypto/vault-key-store";
import { debugLog } from "./debug-log";
import { formatHistorySize, formatHistoryTime, isBinaryContent } from "./history-view";
import type PickpenPlugin from "./index";
import { isUnauthenticated } from "./remote-connect";
import { createSyncFilter } from "./sync/selective";
import { writeLocalFile } from "./sync/vault-io";
import { captureOpenViews, refreshOpenViews } from "./view-sync";
import type { DeletedFile, FileVersionInfo } from "./gen/proto/sync/sync.ext_pb";

const PAGE_SIZE = 50;
/** 单条删除记录的内容定位：同 file_id 的历史版本一页足够（删除事件必在保留期内） */
const VERSION_LOOKUP_SIZE = 50;

/**
 * 从某 file_id 的历史版本里挑出「这条删除记录」对应的那一版。
 * 不能直接取最新一条：同一路径「删除 → 重建 → 再改」时，最新版本晚于删除事件，会预览到错内容。
 * 优先精确匹配 (revision, createdAt === deletedAt)，否则取不晚于删除时刻的最新一条。
 */
export function pickDeletedVersion(
	versions: FileVersionInfo[],
	revision: bigint,
	deletedAt: bigint,
): FileVersionInfo | null {
	if (versions.length === 0) return null;
	const exact = versions.find((v) => v.revision === revision && v.createdAt === deletedAt);
	if (exact) return exact;
	// 版本列表按 created_at 倒序：不晚于删除时刻的第一条即所需版本
	const notLater = versions.find((v) => v.createdAt <= deletedAt);
	return notLater ?? versions[versions.length - 1] ?? null;
}

/** installDeletedFilesFeature 注册命令面板入口「查看已删除的文件」 */
export function installDeletedFilesFeature(plugin: PickpenPlugin): void {
	plugin.addCommand({
		id: "deleted-files",
		name: "查看已删除的文件",
		callback: () => {
			if (!plugin.settings.accessToken || !plugin.settings.vaultId) {
				new Notice("请先登录并绑定仓库");
				return;
			}
			openDeletedFiles(plugin.app, plugin);
		},
	});
}

// openDeletedFiles 打开「已删除的文件」弹窗（命令面板 / 设置面板「同步」区共用）
export function openDeletedFiles(app: App, plugin: PickpenPlugin): void {
	new DeletedFilesModal(app, plugin).open();
}

class DeletedFilesModal extends Modal {
	private readonly plugin: PickpenPlugin;

	private files: DeletedFile[] = [];
	private pageToken = "";
	private hasMore = false;
	private loading = false;
	private closed = false;
	private selected: DeletedFile | null = null;
	private selectedVersion: FileVersionInfo | null = null;
	private selectedContent: Uint8Array | null = null;
	private selectedText: string | null = null;
	private selectedBinary = false;
	private restoring = false;
	private selectionGeneration = 0;
	/** 移动端详情页：列表容器此时是游离节点，renderList 不参与绘制 */
	private detailOpen = false;
	private markdownComponent: Component | null = null;

	private mainEl!: HTMLElement;
	private listEl!: HTMLElement;
	private previewHeadEl!: HTMLElement;
	private actionRowEl!: HTMLElement;
	private previewBodyEl!: HTMLElement;
	private restoreButton: ButtonComponent | null = null;

	constructor(app: App, plugin: PickpenPlugin) {
		super(app);
		this.plugin = plugin;
		this.modalEl.classList.add("pickpen-history-modal", "pickpen-deleted-modal");
		if (Platform.isMobile) this.modalEl.classList.add("is-mobile");
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		if (Platform.isMobile) {
			contentEl.addClass("pickpen-history-mobile-content");
			this.setTitle("已删除的文件");
			this.mainEl = contentEl.createDiv({ cls: "pickpen-history-mobile-main" });
			this.mountMobileList();
		} else {
			const header = contentEl.createDiv({ cls: "pickpen-history-header" });
			header.createEl("h3", { text: "已删除的文件" });
			new ButtonComponent(header)
				.setButtonText("刷新")
				.onClick(() => {
					this.files = [];
					this.pageToken = "";
					void this.loadFiles(true);
				});
			contentEl.createDiv({ cls: "pickpen-history-path", text: "删除时间倒序；仅含保留期内的记录" });
			this.mainEl = contentEl.createDiv({ cls: "pickpen-history-split" });
			const listPane = this.mainEl.createDiv({ cls: "pickpen-history-list-pane" });
			this.listEl = listPane.createDiv({ cls: "pickpen-history-list" });
			const previewPane = this.mainEl.createDiv({ cls: "pickpen-history-pane" });
			this.previewHeadEl = previewPane.createDiv({ cls: "pickpen-history-preview-head" });
			this.actionRowEl = previewPane.createDiv({ cls: "pickpen-history-restore" });
			this.previewBodyEl = previewPane.createDiv({ cls: "pickpen-history-preview-body markdown-preview-view" });
			this.previewHeadEl.createDiv({ cls: "pickpen-vault-message", text: "选择左侧条目查看内容" });
		}
		await this.loadFiles(true);
	}

	onClose(): void {
		this.closed = true;
		this.selectionGeneration++;
		this.disposeMarkdown();
		this.files = [];
		this.contentEl.empty();
	}

	/** 移动端列表页（返回时重建） */
	private mountMobileList(): void {
		this.detailOpen = false;
		this.mainEl.empty();
		this.listEl = this.mainEl.createDiv({ cls: "pickpen-history-list is-mobile" });
		if (this.files.length > 0) this.renderList();
		else if (this.loading) this.renderLoading(this.listEl, "正在加载已删除的文件…");
	}

	/** 移动端详情页：返回按钮 + 预览 + 恢复 */
	private mountMobileDetail(): void {
		this.detailOpen = true;
		this.mainEl.empty();
		this.listEl = createDiv(); // 游离：renderList 的绘制目标不在 DOM 中
		const actions = this.mainEl.createDiv({ cls: "pickpen-history-mobile-actions" });
		new ButtonComponent(actions).setButtonText("返回列表").onClick(() => this.mountMobileList());
		this.actionRowEl = this.mainEl.createDiv({ cls: "pickpen-history-restore is-mobile" });
		this.previewHeadEl = this.mainEl.createDiv({ cls: "pickpen-history-preview-head is-mobile" });
		this.previewBodyEl = this.mainEl.createDiv({
			cls: "pickpen-history-preview-body is-mobile markdown-preview-view",
		});
	}

	private disposeMarkdown(): void {
		if (!this.markdownComponent) return;
		this.markdownComponent.unload();
		this.markdownComponent = null;
	}

	/** loadFiles 拉取一页删除记录（first = 首页，清空右侧预览并重绘列表） */
	private async loadFiles(first: boolean): Promise<void> {
		if (this.loading || this.closed) return;
		this.loading = true;
		if (first) {
			this.files = [];
			this.selected = null;
			this.selectedVersion = null;
			this.selectedContent = null;
			this.selectedText = null;
			this.disposeMarkdown();
			if (Platform.isMobile && this.detailOpen) this.mountMobileList();
		}
		if (first || this.listEl === undefined) this.renderLoading(this.listEl, "正在加载已删除的文件…");
		try {
			const resp = await this.plugin.remote.listDeletedFiles(PAGE_SIZE, this.pageToken);
			if (this.closed) return;
			this.files.push(...resp.files);
			this.pageToken = resp.nextPageToken;
			this.hasMore = resp.hasMore;
			if (Platform.isMobile && this.detailOpen) return; // 详情页期间不重绘列表
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
			error.createDiv({ cls: "pickpen-vault-message is-error", text: `加载失败：${e.rawMessage ?? String(err)}` });
			new ButtonComponent(error).setButtonText("重试").onClick(() => void this.loadFiles(first));
		} finally {
			this.loading = false;
		}
	}

	private renderLoading(container: HTMLElement, text: string): void {
		container.empty();
		const loading = container.createDiv({ cls: "pickpen-history-loading" });
		loading.createDiv({ cls: "pickpen-history-spinner", attr: { "aria-hidden": "true" } });
		loading.createSpan({ text });
	}

	private renderList(): void {
		this.listEl.empty();
		if (this.files.length === 0) {
			this.listEl.createDiv({ cls: "pickpen-vault-message", text: "暂无已删除的文件" });
			return;
		}
		for (const file of this.files) this.renderItem(file);
		if (!this.hasMore) return;
		const more = this.listEl.createDiv({ cls: "pickpen-history-load-more" });
		const button = new ButtonComponent(more).setButtonText("加载更多").onClick((evt) => {
			const btn = evt.currentTarget as HTMLElement;
			btn.setAttribute("disabled", "");
			button.setButtonText("加载中…");
			void this.loadFiles(false).finally(() => {
				btn.removeAttribute("disabled");
				button.setButtonText("加载更多");
			});
		});
	}

	/** 单个条目：删除时间 + 删除前大小 + 路径 */
	private renderItem(file: DeletedFile): void {
		const isSelected = this.selected === file;
		const item = this.listEl.createDiv({
			cls: `pickpen-history-item${Platform.isMobile ? " pickpen-history-mobile-item" : ""}${isSelected ? " is-selected" : ""}`,
		});
		const meta = item.createDiv({ cls: "pickpen-history-item-meta" });
		meta.createDiv({ cls: "pickpen-history-item-time", text: formatHistoryTime(file.deletedAt) });
		meta.createDiv({ cls: "pickpen-history-item-size", text: formatHistorySize(file.size) });
		item.createDiv({ cls: "pickpen-history-item-path", text: file.path });
		item.addEventListener("click", () => void this.select(file));
	}

	/** 选中条目：定位删除前那一版，按需解锁后预览 */
	private async select(file: DeletedFile): Promise<void> {
		if (this.restoring) return;
		this.selectionGeneration++;
		const generation = this.selectionGeneration;
		this.disposeMarkdown();
		this.selected = file;
		this.selectedVersion = null;
		this.selectedContent = null;
		this.selectedText = null;
		this.selectedBinary = false;
		if (Platform.isMobile) {
			this.mountMobileDetail();
		} else {
			this.renderList();
			this.previewHeadEl.empty();
			this.previewHeadEl.createSpan({ text: formatHistoryTime(file.deletedAt) });
			this.previewHeadEl.createSpan({ text: `r${file.revision}` });
			this.previewHeadEl.createSpan({ text: file.path });
			this.renderDesktopActions();
		}
		this.renderLoading(this.previewBodyEl, "正在加载删除前的内容…");

		let version: FileVersionInfo | null;
		try {
			const resp = await this.plugin.remote.listFileVersions(file.fileId, VERSION_LOOKUP_SIZE, "");
			version = pickDeletedVersion(resp.versions, file.revision, file.deletedAt);
		} catch (err) {
			if (!this.isCurrent(file, generation)) return;
			this.previewBodyEl.empty();
			this.previewBodyEl.createDiv({ cls: "pickpen-vault-message is-error", text: this.errorText(err) });
			return;
		}
		if (!this.isCurrent(file, generation)) return;
		this.selectedVersion = version;
		if (!version || !version.contentHash) {
			// 目录条目（历史版本内容哈希为空串）：只展示路径，不提供预览，也不给恢复入口
			this.previewBodyEl.empty();
			this.previewBodyEl.createDiv({ cls: "pickpen-vault-message", text: "该条目是目录，不支持预览与恢复" });
			this.actionRowEl.empty();
			this.restoreButton = null;
			return;
		}
		// 内容读取走既有历史通道：加密仓库需要先解锁（列表本身不需要）
		if (!(await this.plugin.ensureVaultUnlocked(true))) {
			this.previewBodyEl.empty();
			this.previewBodyEl.createDiv({ cls: "pickpen-vault-message", text: "仓库已加密，解锁后才能查看与恢复" });
			this.updateActions();
			return;
		}
		if (!this.isCurrent(file, generation)) return;
		let content: Uint8Array;
		try {
			content = await openForLocal(
				await this.plugin.remote.getBlob(version.contentHash, 0n, "", version.fileId),
				true,
			);
		} catch (err) {
			if (!this.isCurrent(file, generation)) return;
			this.previewBodyEl.empty();
			this.previewBodyEl.createDiv({ cls: "pickpen-vault-message is-error", text: this.errorText(err) });
			return;
		}
		if (!this.isCurrent(file, generation)) return;
		this.selectedContent = content;
		this.selectedBinary = isBinaryContent(content);
		if (!this.selectedBinary) this.selectedText = new TextDecoder("utf-8").decode(content);
		this.updateActions();
		await this.renderPreview();
	}

	private isCurrent(file: DeletedFile, generation: number): boolean {
		return !this.closed && this.selected === file && this.selectionGeneration === generation;
	}

	private async renderPreview(): Promise<void> {
		const file = this.selected;
		if (!file || this.selectedContent === null) return;
		this.disposeMarkdown();
		this.previewBodyEl.empty();
		if (this.selectedBinary || this.selectedText === null) {
			this.previewBodyEl.createDiv({ cls: "pickpen-vault-message", text: "二进制内容，无法预览（仍可恢复）" });
			return;
		}
		const target = createDiv({ cls: ["markdown-preview-sizer", "markdown-preview-section"] });
		const component = new Component();
		component.load();
		try {
			await MarkdownRenderer.render(this.app, this.selectedText, target, file.path, component);
		} catch (err) {
			component.unload();
			if (this.closed) return;
			this.previewBodyEl.createDiv({
				cls: "pickpen-vault-message is-error",
				text: `Markdown 渲染失败：${String(err)}`,
			});
			return;
		}
		if (this.closed || this.selected !== file) {
			component.unload();
			return;
		}
		this.markdownComponent = component;
		this.previewBodyEl.appendChild(target);
	}

	private renderDesktopActions(): void {
		this.actionRowEl.empty();
		this.actionRowEl.addClass("pickpen-history-desktop-actions");
		this.restoreButton = new ButtonComponent(this.actionRowEl)
			.setButtonText("恢复到原路径")
			.setDisabled(true)
			.onClick(() => void this.restore());
	}

	private updateActions(): void {
		this.restoreButton?.setDisabled(this.restoring || this.selectedContent === null);
	}

	/** 恢复：写回删除时的原路径（父目录自动补建；目标已有同名文件时先确认，绝不静默覆盖） */
	private async restore(): Promise<void> {
		const file = this.selected;
		const content = this.selectedContent;
		if (!file || !content || this.restoring) return;
		if (await this.pathExists(file.path)) {
			this.confirmOverwrite(file.path, content);
			return;
		}
		await this.writeRestored(file.path, content);
	}

	private confirmOverwrite(path: string, content: Uint8Array): void {
		this.actionRowEl.empty();
		this.actionRowEl.createDiv({
			cls: "pickpen-history-confirm-text",
			text: `该路径已存在同名文件（${path}），恢复将覆盖它。确认？`,
		});
		new ButtonComponent(this.actionRowEl)
			.setButtonText("确认恢复")
			.setDestructive()
			.setCta()
			.onClick(() => void this.writeRestored(path, content));
		new ButtonComponent(this.actionRowEl)
			.setButtonText("取消")
			.onClick(() => {
				if (Platform.isMobile) {
					this.actionRowEl.empty();
					this.restoreButton = new ButtonComponent(this.actionRowEl)
						.setButtonText("恢复到原路径")
						.onClick(() => void this.restore());
				} else {
					this.renderDesktopActions();
				}
				this.updateActions();
			});
	}

	private async writeRestored(path: string, content: Uint8Array): Promise<void> {
		this.restoring = true;
		this.updateActions();
		try {
			// 一律走 adapter 直写：配置目录内的路径在 vault 索引之外，createBinary 会失败
			await writeLocalFile(this.app, path, content);
			const states = await captureOpenViews(this.app, path);
			await refreshOpenViews(this.app, states, content, /* force */ true); // 恢复是显式确认操作，跳过快照规则
		} catch (err) {
			this.restoring = false;
			debugLog.error("[pickpen] 恢复已删除文件写盘失败", err);
			new Notice("恢复写盘失败，请重试");
			this.updateActions();
			return;
		}
		// adapter 写盘不触发 vault 事件，必须显式传 dirtyPaths 才会被扫描上传
		this.plugin.session.requestRun({ dirtyPaths: new Set([path]) });
		if (this.pathExcluded(path)) {
			// 该路径当前被类型/文件夹排除规则挡住：写盘成功但不会上传，明确告知避免误会
			new Notice(`已恢复到 ${path}；该路径当前不在同步范围内，不会上传`);
		} else {
			new Notice("已恢复，正在同步…");
		}
		this.close();
	}

	private async pathExists(path: string): Promise<boolean> {
		if (this.app.vault.getAbstractFileByPath(path)) return true;
		try {
			return await this.app.vault.adapter.exists(path);
		} catch {
			return false;
		}
	}

	/** 该路径当前是否被选择性同步排除（类型 / 文件夹 / 配置分类）。恢复只对文件开放，故按文件判定 */
	private pathExcluded(path: string): boolean {
		const settings = this.plugin.settings;
		const filter = createSyncFilter({
			selective: settings.selective,
			configDir: this.app.vault.configDir,
			selfDir: this.plugin.manifest.dir ?? "",
			selfId: this.plugin.manifest.id,
		});
		return filter.isExcluded(path);
	}

	/** 内容读取失败文案（版本已被保留期裁剪、仓库未解锁等） */
	private errorText(err: unknown): string {
		const e = err as { rawMessage?: string };
		return e.rawMessage ?? String(err);
	}
}

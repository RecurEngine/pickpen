// 设置页「邀请」区块：邀请码、邀请人数与邀请用户列表（分页加载）。
// 邀请码与统计来自 InviteService；列表邮箱由服务端打码后下发，插件不做还原。

import { ButtonComponent, Modal, Notice, Platform, Setting } from "obsidian";

import { debugLog } from "./debug-log";
import type { Invitee } from "./gen/proto/invite/invite_pb";
import type PickpenPlugin from "./index";
import { ErrCode, errorCode, isUnauthenticated } from "./remote-connect";

const PAGE_SIZE = 20;

/** 邀请进度行：邀请上限为 0 表示当前不可邀请。 */
export function inviteProgressRows(inviteLimit: bigint, invitedCount: bigint, paidCount: bigint) {
	return [
		{ label: "邀请人数", value: inviteLimit === 0n ? "当前不可邀请" : `${invitedCount.toString()} / ${inviteLimit.toString()}` },
		{ label: "邀请充值", value: `${paidCount.toString()} 人` },
	];
}

/** 邀请奖励说明文案；时长由服务端下发，插件不内置业务常量。 */
export function inviteRewardText(rewardDays: bigint, rewardMonths: bigint): string {
	const parts: string[] = [];
	if (rewardDays > 0n) parts.push(`每邀请 1 位好友注册得 ${rewardDays.toString()} 天 Pro`);
	if (rewardMonths > 0n) parts.push(`好友首次付费再得 ${rewardMonths.toString()} 个月 Pro`);
	return parts.join("，");
}

export function inviteErrorMessage(err: unknown): string {
	switch (errorCode(err)) {
		case ErrCode.InviteRequestInvalid:
			return "邀请信息加载失败：请求参数非法";
		default:
			return "邀请信息加载失败：网络不可达或服务端异常";
	}
}

/** 渲染桌面与移动设置页的邀请区域，并返回异步回写的清理函数。 */
export function renderInviteSection(containerEl: HTMLElement, plugin: PickpenPlugin): () => void {
	let disposed = false;
	const root = containerEl.createDiv({ cls: "pickpen-invite" });

	if (!plugin.settings.accessToken) {
		new Setting(root).setName("登录后查看邀请").setDesc("请先在上方完成账号登录");
		return () => {
			disposed = true;
		};
	}

	const renderError = (message: string) => {
		if (disposed) return;
		root.empty();
		const row = new Setting(root).setName("邀请信息加载失败").setDesc(message);
		row.addButton((button) => button.setButtonText("重试").onClick(() => void load()));
	};

	const load = async () => {
		if (disposed) return;
		root.empty();
		root.createDiv({ cls: "pickpen-invite-loading", text: "正在加载邀请信息…" });
		try {
			const reply = await plugin.client.inviteClient.getInviteInfo({});
			if (disposed) return;
			root.empty();
			renderInfo(root, plugin, reply.inviteCode, reply.invitedCount, reply.paidCount, reply.inviteLimit, reply.rewardDays, reply.rewardMonths);
		} catch (err) {
			renderError(inviteErrorMessage(err));
			debugLog.error(`[pickpen] 邀请信息加载失败，错误码：${errorCode(err) ?? "unknown"}`);
		}
	};

	void load();
	return () => {
		disposed = true;
	};
}

function renderInfo(
	root: HTMLElement,
	plugin: PickpenPlugin,
	inviteCode: string,
	invitedCount: bigint,
	paidCount: bigint,
	inviteLimit: bigint,
	rewardDays: bigint,
	rewardMonths: bigint,
): void {
	const reward = inviteRewardText(rewardDays, rewardMonths);
	const codeSetting = new Setting(root).setName("邀请码");
	if (inviteCode) {
		if (reward) codeSetting.setDesc(reward);
		codeSetting.addText((text) => {
			text.setValue(inviteCode).setDisabled(true);
			text.inputEl.addClass("pickpen-invite-code");
		});
		codeSetting.addButton((button) =>
			button.setButtonText("复制").onClick(async () => {
				const copied = await copyText(inviteCode);
				new Notice(copied ? "邀请码已复制" : "复制失败：请手动选择复制");
			}),
		);
	} else {
		codeSetting.setDesc("当前不可邀请，如需调整上限请联系客服");
	}

	// 邀请人数、邀请充值与「查看邀请用户」入口同处一行，避免占用多条设置行的垂直空间。
	const stats = root.createDiv({ cls: "pickpen-invite-stats" });
	for (const row of inviteProgressRows(inviteLimit, invitedCount, paidCount)) {
		const stat = stats.createDiv({ cls: "pickpen-invite-stat" });
		stat.createDiv({ cls: "pickpen-invite-stat-label", text: row.label });
		stat.createDiv({ cls: "pickpen-invite-stat-value", text: row.value });
	}
	const action = new ButtonComponent(stats).setButtonText("查看邀请用户").onClick(() => new InviteesModal(plugin).open());
	action.buttonEl.addClass("pickpen-invite-stat-action");
}

// copyText 复制文本：webview（移动端）navigator.clipboard 可能不可用，回退 textarea + execCommand
async function copyText(value: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(value);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = value;
		area.className = "pickpen-clipboard-fallback";
		document.body.appendChild(area);
		area.select();
		const done = document.execCommand("copy");
		document.body.removeChild(area);
		return done;
	}
}

class InviteesModal extends Modal {
	private readonly plugin: PickpenPlugin;
	private invitees: Invitee[] = [];
	private pageToken = "";
	private hasMore = false;
	private loading = false;
	private closed = false;
	private listEl!: HTMLElement;
	private summaryEl!: HTMLElement;

	constructor(plugin: PickpenPlugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.modalEl.classList.add("pickpen-invite-modal");
		if (Platform.isMobile) this.modalEl.classList.add("is-mobile");
	}

	onOpen(): void {
		this.setTitle("邀请用户");
		this.summaryEl = this.contentEl.createDiv({ cls: "pickpen-invite-summary" });
		this.listEl = this.contentEl.createDiv({ cls: "pickpen-invite-list" });
		const actions = this.contentEl.createDiv({ cls: "pickpen-invite-actions" });
		new ButtonComponent(actions)
			.setButtonText("刷新")
			.onClick(() => void this.load(true));
		new ButtonComponent(actions)
			.setButtonText("关闭")
			.onClick(() => this.close());
		void this.load(true);
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}

	// load 拉取一页（first = 首页全量重绘；否则追加）；防重入，关闭后丢弃回包
	private async load(first: boolean): Promise<void> {
		if (this.loading || this.closed) return;
		this.loading = true;
		if (first && this.invitees.length === 0) {
			this.listEl.empty();
			this.listEl.createDiv({ cls: "pickpen-vault-message", text: "正在加载邀请用户…" });
		}
		try {
			const reply = await this.plugin.client.inviteClient.listInvitees({
				pageSize: PAGE_SIZE,
				pageToken: first ? "" : this.pageToken,
			});
			if (this.closed) return;
			if (first) {
				this.invitees = [];
				this.listEl.empty();
			}
			this.invitees.push(...reply.invitees);
			this.pageToken = reply.nextPageToken;
			this.hasMore = reply.nextPageToken !== "";
			this.renderList(Number(reply.total));
		} catch (err) {
			if (this.closed) return;
			if (first) this.listEl.empty();
			if (isUnauthenticated(err)) {
				this.listEl.createDiv({ cls: "pickpen-vault-message is-error", text: "登录已失效，请重新登录" });
				return;
			}
			const error = this.listEl.createDiv({ cls: "pickpen-invite-load-error" });
			error.createDiv({ cls: "pickpen-vault-message is-error", text: inviteErrorMessage(err) });
			new ButtonComponent(error).setButtonText("重试").onClick(() => void this.load(first));
		} finally {
			this.loading = false;
		}
	}

	private renderList(total: number): void {
		this.listEl.empty();
		this.summaryEl.setText(`共 ${total} 位好友`);
		if (this.invitees.length === 0) {
			this.listEl.createDiv({ cls: "pickpen-vault-message", text: "还没有邀请记录" });
			return;
		}
		for (const invitee of this.invitees) {
			const item = this.listEl.createDiv({
				cls: `pickpen-invite-item${Platform.isMobile ? " pickpen-invite-mobile-item" : ""}`,
			});
			const meta = item.createDiv({ cls: "pickpen-invite-item-meta" });
			meta.createDiv({ cls: "pickpen-invite-item-email", text: invitee.email || "—" });
			meta.createDiv({ cls: "pickpen-invite-item-time", text: formatInviteTime(invitee.registeredAtMs) });
			item.createDiv({
				cls: `pickpen-invite-badge${invitee.paid ? " is-paid" : ""}`,
				text: invitee.paid ? "已充值" : "未充值",
			});
		}
		if (this.hasMore) {
			const more = this.listEl.createDiv({ cls: "pickpen-invite-load-more" });
			const button = new ButtonComponent(more).setButtonText("加载更多").onClick((evt) => {
				const btn = evt.currentTarget as HTMLElement;
				btn.setAttribute("disabled", "");
				button.setButtonText("加载中…");
				void this.load(false).finally(() => {
					btn.removeAttribute("disabled");
					button.setButtonText("加载更多");
				});
			});
		}
	}
}

/** 邀请列表时间展示：毫秒时间戳 → YYYY-MM-DD HH:mm */
export function formatInviteTime(ms: bigint): string {
	if (ms <= 0n) return "—";
	const date = new Date(Number(ms));
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

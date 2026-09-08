// 仓库管理（Snapshot 同步 v2）：登录后从远端仓库列表选择绑定 + 增删改（List/Create/Update/DeleteVault）。
// 仓库按 vault_id 定位（spec §11），绑定后持久化 vault_id、名字仅展示。
// 重命名仅改远端元数据（Blob 按 hash 寻址，内容存储不动），管理操作期间暂停本机同步。

import { App, ButtonComponent, Modal, Notice, TextComponent } from "obsidian";

import { debugLog } from "./debug-log";
import type { Plan } from "./gen/proto/subscription/subscription_pb";
import type PickpenPlugin from "./index";
import { ErrCode, errorCode, isUnauthenticated, type RemoteClient } from "./remote-connect";
import { syncState } from "./sync-state";
import type { VaultInfo } from "./types";

export interface VaultQuota {
	count: bigint;
	limit: bigint;
	atLimit: boolean;
}

// resolveVaultQuota 按当前订阅档位解析仓库用量；无付费订阅时使用 Free 档位。
export function resolveVaultQuota(
	plans: readonly Pick<Plan, "id" | "vaultLimit">[],
	currentPlanId: string | undefined,
	vaultCount: bigint,
): VaultQuota | undefined {
	const plan = plans.find((item) => item.id === (currentPlanId ?? "free"));
	if (!plan || plan.vaultLimit <= 0n || vaultCount < 0n) return undefined;
	return { count: vaultCount, limit: plan.vaultLimit, atLimit: vaultCount >= plan.vaultLimit };
}

export function formatVaultQuota(quota: VaultQuota | undefined): string {
	return quota
		? `仓库数量：${quota.count.toString()} / ${quota.limit.toString()} 个（已创建 / 总上限）`
		: "仓库数量：暂不可用";
}

// fetchVaults 列出当前用户全部仓库（int64 → 十进制字符串）
export async function fetchVaults(client: RemoteClient): Promise<VaultInfo[]> {
	const resp = await client.syncClient.listVaults({});
	return resp.vaults.map((v) => ({
		vaultId: String(v.vaultId),
		name: v.name,
		revision: String(v.revision),
		rootHash: v.rootHash,
	}));
}

// fetchVaultQuota 从订阅接口获取已创建数量和当前套餐总上限。
export async function fetchVaultQuota(client: RemoteClient): Promise<VaultQuota | undefined> {
	const [plansReply, subscriptionReply] = await Promise.all([
		client.subscriptionClient.listPlans({}),
		client.subscriptionClient.getSubscription({}),
	]);
	return resolveVaultQuota(plansReply.plans, subscriptionReply.current?.planId, subscriptionReply.vaultCount);
}

// createRemoteVault 显式新建仓库（同名幂等返回已有仓库）
export async function createRemoteVault(client: RemoteClient, name: string): Promise<VaultInfo> {
	const resp = await client.syncClient.createVault({ name });
	const v = resp.vault!;
	return { vaultId: String(v.vaultId), name: v.name, revision: String(v.revision), rootHash: v.rootHash };
}

// renameRemoteVault 重命名仓库（仅改远端元数据）
export async function renameRemoteVault(client: RemoteClient, vaultId: string, newName: string): Promise<VaultInfo> {
	const resp = await client.syncClient.updateVault({ vaultId: BigInt(vaultId), newName });
	const v = resp.vault!;
	return { vaultId: String(v.vaultId), name: v.name, revision: String(v.revision), rootHash: v.rootHash };
}

// deleteRemoteVault 删除仓库（远端数据不可恢复）
export async function deleteRemoteVault(client: RemoteClient, vaultId: string): Promise<void> {
	await client.syncClient.deleteVault({ vaultId: BigInt(vaultId) });
}

// openVaultManager 打开仓库管理弹窗（登录后自动打开 / 设置面板「仓库管理」按钮）；
// onChange 在绑定状态可能变化后回调（供设置页重渲染）
export function openVaultManager(app: App, plugin: PickpenPlugin, onChange?: () => void): void {
	new VaultManagerModal(app, plugin, onChange).open();
}

class VaultManagerModal extends Modal {
	private plugin: PickpenPlugin;
	private onChange?: () => void;
	private vaults: VaultInfo[] = [];
	private quota: VaultQuota | undefined;
	private descEl!: HTMLElement;
	private quotaEl!: HTMLElement;
	private actionsEl!: HTMLElement;
	private listEl!: HTMLElement;

	constructor(app: App, plugin: PickpenPlugin, onChange?: () => void) {
		super(app);
		this.plugin = plugin;
		this.onChange = onChange;
		this.modalEl.classList.add("pickpen-vault-manager-modal"); // 弹窗加宽（styles.css）
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		// 标题行：h3 与「刷新列表」同行（header 只在 onOpen 构建一次，refresh 不碰它）
		const header = contentEl.createDiv({ cls: "pickpen-vault-header" });
		header.createEl("h3", { text: "仓库管理" });
		new ButtonComponent(header)
			.setButtonText("刷新列表")
			.onClick(() => void this.refresh());
		this.descEl = contentEl.createDiv({ cls: "setting-item-description pickpen-vault-desc" });
		this.quotaEl = contentEl.createDiv({ cls: "setting-item-description pickpen-vault-quota" });
		this.actionsEl = contentEl.createDiv();
		this.listEl = contentEl.createDiv({ cls: "pickpen-vault-list" });
		await this.refresh();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}

	// refresh 拉取列表并重绘；失败内联红字（不抛出，可重试）
	private async refresh(): Promise<void> {
		// 顶部操作区：未绑定时新建并绑定；已绑定时只新建其他仓库、不换绑。
		this.actionsEl.empty();
		const bound = !!this.plugin.settings.vaultId;
		this.descEl.textContent = bound
			? `已绑定：${this.plugin.settings.vaultName}，不可换绑其他仓库`
			: "选择要绑定的仓库，或新建";
		this.quotaEl.textContent = "仓库数量：加载中…";
		this.listEl.empty();
		const loading = this.listEl.createDiv({ cls: "pickpen-vault-message", text: "加载中…" });
		const [vaultsResult, quotaResult] = await Promise.allSettled([
			fetchVaults(this.plugin.client),
			fetchVaultQuota(this.plugin.client),
		]);
		if (quotaResult.status === "fulfilled") {
			this.quota = quotaResult.value;
		} else {
			this.quota = undefined;
			debugLog.error(`[pickpen] 仓库额度加载失败，错误码：${errorCode(quotaResult.reason) ?? "unknown"}`);
		}
		this.quotaEl.textContent = formatVaultQuota(this.quota);
		this.renderCreateAction(bound);

		if (vaultsResult.status === "rejected") {
			const err = vaultsResult.reason;
			if (isUnauthenticated(err)) {
				loading.remove();
				this.listEl.createDiv({ cls: "pickpen-vault-message is-error", text: "登录已失效，请重新登录" });
				return;
			}
			const e = err as { rawMessage?: string };
			loading.remove();
			this.listEl.createDiv({ cls: "pickpen-vault-message is-error", text: `列表加载失败：${e.rawMessage ?? String(err)}（可点击刷新重试）` });
			return;
		}
		this.vaults = vaultsResult.value;
		loading.remove();
		if (this.vaults.length === 0) {
			this.listEl.createDiv({
				cls: "pickpen-vault-message",
				text: bound ? "仓库列表为空" : "该账号暂无仓库，请在上方新建",
			});
			return;
		}
		for (const v of this.vaults) {
			this.renderItem(v);
		}
	}

	private renderCreateAction(bound: boolean): void {
		let newName = "";
		const atLimit = this.quota?.atLimit ?? false;
		const createCard = this.actionsEl.createDiv({ cls: "pickpen-vault-card pickpen-vault-create" });
		new TextComponent(createCard)
			.setPlaceholder(this.plugin.app.vault.getName())
			.setDisabled(atLimit)
			.onChange((value) => (newName = value.trim()));
		const createButtonText = atLimit ? "已达仓库上限" : bound ? "新建仓库" : "新建并绑定";
		const createButton = new ButtonComponent(createCard)
			.setButtonText(createButtonText)
			.setCta()
			.setDisabled(atLimit);
		if (atLimit) {
			createButton.setTooltip("仓库数量已达当前套餐上限");
		} else {
			createButton.onClick(() => {
				void (bound ? this.createOnly(newName) : this.createAndBind(newName));
			});
		}
	}

	// renderItem 单个仓库卡片：head（名称+徽标）+ foot（revision+按钮组）
	private renderItem(v: VaultInfo): void {
		const isBound = this.plugin.settings.vaultId === v.vaultId;
		const isEmpty = v.revision === "0";
		const card = this.listEl.createDiv({ cls: `pickpen-vault-card${isBound ? " is-current" : ""}` });
		// 头部行：名称（粗体、超长省略）+ 徽标组
		const head = card.createDiv({ cls: "pickpen-vault-card-head" });
		head.createDiv({ cls: "pickpen-vault-card-name", text: v.name });
		const badges = head.createDiv({ cls: "pickpen-vault-badges" });
		if (isBound) badges.createDiv({ cls: "pickpen-vault-badge is-bound", text: "当前绑定" });
		if (isEmpty) badges.createDiv({ cls: "pickpen-vault-badge is-empty", text: "空仓库" });
		// 底部行：revision 信息（左）+ 操作按钮组（右）
		const foot = card.createDiv({ cls: "pickpen-vault-card-foot" });
		foot.createDiv({ cls: "pickpen-vault-meta", text: `revision ${v.revision}` });
		const actions = foot.createDiv({ cls: "pickpen-vault-actions" });
		if (!isBound && !this.plugin.settings.vaultId) {
			new ButtonComponent(actions)
				.setButtonText("绑定")
				.setCta()
				.onClick(() => void this.bind(v));
		}
		new ButtonComponent(actions).setButtonText("重命名").onClick(() => this.startRename(v, card));
		const deleteButton = new ButtonComponent(actions)
			.setButtonText("删除")
			.setWarning();
		if (isBound) {
			deleteButton.setDisabled(true).setTooltip("当前绑定仓库不可删除");
		} else {
			deleteButton.onClick(() => this.startDelete(v, card));
		}
	}

	// bind 绑定仓库（切换合并语义由 bindVault 内部处理）
	private bind(v: VaultInfo): void {
		this.close();
		void this.plugin
			.bindVault(v.vaultId, v.name)
			.then(() => this.onChange?.()) // 绑定完成后再刷新设置页（close 时 settings 尚未更新）
			.catch((err) => {
				const e = err as { rawMessage?: string };
				debugLog.error(`[pickpen] 绑定仓库失败，错误码：${errorCode(err) ?? "unknown"}`);
				new Notice(`绑定失败：${e.rawMessage ?? "未知错误"}`);
			});
	}

	private async create(name: string): Promise<VaultInfo | undefined> {
		if (!name) {
			new Notice("请输入仓库名称（≤128 字符、不含 / 与 \\）");
			return undefined;
		}
		if (this.quota?.atLimit) {
			new Notice("仓库数量已达当前套餐上限");
			return undefined;
		}
		try {
			return await createRemoteVault(this.plugin.client, name);
		} catch (err) {
			if (isUnauthenticated(err)) {
				new Notice("登录已失效，请重新登录");
				this.close();
				return undefined;
			}
			if (errorCode(err) === ErrCode.VaultLimitExceeded) {
				new Notice("仓库数量已达当前套餐上限");
				await this.refresh();
				return undefined;
			}
			const e = err as { rawMessage?: string };
			debugLog.error(`[pickpen] 新建仓库失败，错误码：${errorCode(err) ?? "unknown"}`);
			new Notice(`新建失败：${e.rawMessage ?? "名称非法（≤128 字符、不含 / 与 \\）"}`);
			return undefined;
		}
	}

	// createOnly 已绑定时只新建其他仓库，不改变当前同步目标。
	private async createOnly(name: string): Promise<void> {
		const created = await this.create(name);
		if (!created) return;
		new Notice(`仓库已创建：${created.name}`);
		await this.refresh();
	}

	// createAndBind 未绑定时新建并绑定。
	private async createAndBind(name: string): Promise<void> {
		const created = await this.create(name);
		if (!created) return;
		this.close();
		void this.plugin
			.bindVault(created.vaultId, created.name)
			.then(() => this.onChange?.()) // 绑定完成后再刷新设置页（close 时 settings 尚未更新）
			.catch((err) => {
				const e = err as { rawMessage?: string };
				debugLog.error(`[pickpen] 绑定仓库失败，错误码：${errorCode(err) ?? "unknown"}`);
				new Notice(`绑定失败：${e.rawMessage ?? "未知错误"}`);
			});
	}

	// startRename 行内重命名：卡片壳保留，壳内替换为输入框 + 确认/取消
	private startRename(v: VaultInfo, card: HTMLElement): void {
		let newName = v.name;
		card.empty();
		const edit = card.createDiv({ cls: "pickpen-vault-edit" });
		const text = new TextComponent(edit)
			.setValue(v.name)
			.setPlaceholder("新名称（≤128 字符、不含 / 与 \\）")
			.onChange((value) => (newName = value.trim()));
		text.inputEl.select(); // 聚焦并全选旧名，便于直接覆盖输入
		new ButtonComponent(edit)
			.setButtonText("确认")
			.setCta()
			.onClick(() => void this.doRename(v, newName));
		new ButtonComponent(edit).setButtonText("取消").onClick(() => void this.refresh());
	}

	// doRename 执行重命名（仅改远端元数据）；当前绑定仓库 → 本地绑定跟随新名
	private async doRename(v: VaultInfo, newName: string): Promise<void> {
		if (!newName || newName === v.name) {
			await this.refresh();
			return;
		}
		const prevPaused = syncState.pausedReason;
		this.plugin.pauseSync("仓库管理操作中");
		try {
			await renameRemoteVault(this.plugin.client, v.vaultId, newName);
			if (this.plugin.settings.vaultId === v.vaultId) {
				await this.plugin.renameBoundVault(newName);
				this.onChange?.(); // 弹窗不关闭，直接通知设置页刷新仓库名
			}
			new Notice(`已重命名：${v.name} → ${newName}`);
			await this.refresh();
		} catch (err) {
			const e = err as { rawMessage?: string };
			debugLog.error(`[pickpen] 重命名仓库失败，错误码：${errorCode(err) ?? "unknown"}`);
			new Notice(`重命名失败：${e.rawMessage ?? "未知错误"}`);
			await this.refresh();
		} finally {
			this.restorePause(prevPaused);
		}
	}

	// startDelete 删除二次确认（危险操作）：卡片壳内替换为红字提示 + 确认/取消
	private startDelete(v: VaultInfo, card: HTMLElement): void {
		if (this.plugin.settings.vaultId === v.vaultId) {
			new Notice("当前绑定仓库不可删除");
			return;
		}
		card.empty();
		const edit = card.createDiv({ cls: "pickpen-vault-edit" });
		edit.createDiv({ cls: "pickpen-vault-confirm-text", text: "确认删除？远端数据不可恢复！" });
		new ButtonComponent(edit)
			.setButtonText("确认删除")
			.setWarning()
			.setCta()
			.onClick(() => void this.doDelete(v));
		new ButtonComponent(edit).setButtonText("取消").onClick(() => void this.refresh());
	}

	// doDelete 执行删除；当前绑定仓库在界面和执行层均禁止删除
	private async doDelete(v: VaultInfo): Promise<void> {
		if (this.plugin.settings.vaultId === v.vaultId) {
			new Notice("当前绑定仓库不可删除");
			return;
		}
		const prevPaused = syncState.pausedReason;
		this.plugin.pauseSync("仓库管理操作中");
		try {
			await deleteRemoteVault(this.plugin.client, v.vaultId);
			new Notice(`仓库已删除：${v.name}`);
			await this.refresh();
		} catch (err) {
			const e = err as { rawMessage?: string };
			debugLog.error(`[pickpen] 删除仓库失败，错误码：${errorCode(err) ?? "unknown"}`);
			new Notice(`删除失败：${e.rawMessage ?? "未知错误"}`);
			await this.refresh();
		} finally {
			this.restorePause(prevPaused);
		}
	}

	// restorePause 管理操作结束后恢复操作前的暂停/运行状态
	private restorePause(prevPaused: string): void {
		if (prevPaused) {
			this.plugin.pauseSync(prevPaused);
		} else {
			this.plugin.resumeSync();
		}
	}
}

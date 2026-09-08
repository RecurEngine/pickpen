import type { Plan, Subscription } from "./gen/proto/subscription/subscription_pb";

function formatDate(value: bigint): string {
	return new Date(Number(value)).toLocaleString("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function planName(planID: string, plans: readonly Plan[]): string {
	return plans.find((plan) => plan.id === planID)?.name ?? planID;
}

export interface SubscriptionQuotaRow {
	label: string;
	value: string;
}

/** 将字节数格式化为订阅额度使用的紧凑二进制单位。 */
export function formatQuotaBytes(value: bigint): string {
	if (value < 0n) return "暂不可用";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let amount = Number(value);
	let unit = 0;
	while (amount >= 1024 && unit < units.length - 1) {
		amount /= 1024;
		unit += 1;
	}
	const formatted = amount >= 10 || Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(1);
	return `${formatted} ${units[unit]}`;
}

/** 解析当前套餐并生成当前订阅卡片中的额度行。 */
export function subscriptionQuotaRows(
	plans: readonly Plan[],
	current: Subscription | undefined,
	storageBytes: bigint,
	vaultCount: bigint,
): SubscriptionQuotaRow[] {
	const currentPlan = plans.find((plan) => plan.id === (current?.planId ?? "free"));
	const unavailable = "暂不可用";
	const storage =
		currentPlan && currentPlan.storageLimitBytes > 0n && storageBytes >= 0n
			? `${formatQuotaBytes(storageBytes)} / ${formatQuotaBytes(currentPlan.storageLimitBytes)}`
			: unavailable;
	const vaults =
		currentPlan && currentPlan.vaultLimit > 0n && vaultCount >= 0n
			? `${vaultCount.toString()} / ${currentPlan.vaultLimit.toString()} 个`
			: unavailable;
	const maxFileSize =
		currentPlan && currentPlan.maxFileSizeBytes > 0n ? formatQuotaBytes(currentPlan.maxFileSizeBytes) : unavailable;
	let history = unavailable;
	if (currentPlan?.historyRetentionMonths && currentPlan.historyRetentionMonths > 0n) {
		history = `${currentPlan.historyRetentionMonths.toString()} 个月`;
	} else if (currentPlan?.historyRetentionDays && currentPlan.historyRetentionDays > 0n) {
		history = `${currentPlan.historyRetentionDays.toString()} 天`;
	}
	return [
		{ label: "存储空间", value: storage },
		{ label: "仓库数量", value: vaults },
		{ label: "单文件上限", value: maxFileSize },
		{ label: "版本历史", value: history },
	];
}

/** 在桌面和移动设置页统一展示当前档位、有效期与待生效订阅。 */
export function renderSubscriptionState(
	parent: HTMLElement,
	plans: readonly Plan[],
	current: Subscription | undefined,
	scheduled: readonly Subscription[],
	storageBytes: bigint,
	vaultCount: bigint,
): void {
	const card = parent.createDiv({ cls: "pickpen-subscription-card" });
	if (current) {
		const trial = current.source === "trial" ? "（试用）" : "";
		card.createDiv({ cls: "pickpen-subscription-current", text: `当前：${planName(current.planId, plans)}${trial}` });
		card.createDiv({ cls: "pickpen-subscription-meta", text: `有效期至 ${formatDate(current.endsAtMs)}` });
	} else {
		card.createDiv({ cls: "pickpen-subscription-current", text: "当前：Free" });
		card.createDiv({ cls: "pickpen-subscription-meta", text: "暂无生效中的付费订阅" });
	}
	const quotas = card.createDiv({ cls: "pickpen-subscription-quotas" });
	for (const quota of subscriptionQuotaRows(plans, current, storageBytes, vaultCount)) {
		const row = quotas.createDiv({ cls: "pickpen-subscription-quota" });
		row.createDiv({ cls: "pickpen-subscription-quota-label", text: quota.label });
		row.createDiv({ cls: "pickpen-subscription-quota-value", text: quota.value });
	}
	if (scheduled.length === 0) return;

	const schedule = card.createDiv({ cls: "pickpen-subscription-schedule" });
	schedule.createDiv({ cls: "pickpen-subscription-schedule-title", text: "待生效" });
	for (const item of scheduled) {
		schedule.createDiv({
			cls: "pickpen-subscription-schedule-item",
			text: `${planName(item.planId, plans)}：${formatDate(item.startsAtMs)} 至 ${formatDate(item.endsAtMs)}`,
		});
	}
}

import { Notice, Setting } from "obsidian";

import { debugLog } from "./debug-log";
import { openExternal } from "./external-link";
import type PickpenPlugin from "./index";
import { renderPricingLink } from "./subscription-pricing-link";
import { renderSubscriptionState } from "./subscription-state-view";
import { CHECKOUT_URL } from "./types";

const MOBILE_CHECKOUT_ENTRY = "obsidian-mobile";

export function mobileCheckoutUrl(checkoutURL = CHECKOUT_URL): string {
	const url = new URL(checkoutURL);
	url.searchParams.set("entry", MOBILE_CHECKOUT_ENTRY);
	return url.toString();
}

/** 渲染移动端订阅入口：交给官网选择方案并走 WAP 支付。 */
export function renderMobileSubscriptionSection(containerEl: HTMLElement, plugin: PickpenPlugin): () => void {
	let disposed = false;
	new Setting(containerEl).setHeading().setName("当前订阅");
	const statusRoot = containerEl.createDiv({ cls: "pickpen-subscription pickpen-subscription-status" });
	new Setting(containerEl).setHeading().setName("订阅方案");
	const plansRoot = containerEl.createDiv({ cls: "pickpen-subscription pickpen-subscription-plans" });
	let plansRequest: ReturnType<typeof plugin.client.subscriptionClient.listPlans> | undefined;
	const requestPlans = () => {
		if (plansRequest) return plansRequest;
		const request = plugin.client.subscriptionClient.listPlans({});
		plansRequest = request;
		void request.catch(() => {
			if (plansRequest === request) plansRequest = undefined;
		});
		return request;
	};
	const accountHint = plugin.settings.email
		? `当前插件账号：${plugin.settings.email}，请在官网使用同一账号。`
		: "移动端订阅请在拾笔官网完成，将使用手机网站支付。";

	const renderPurchase = () => {
		const purchase = new Setting(plansRoot).setName("前往官网购买").setDesc(accountHint);
		purchase.addButton((button) =>
			button
				.setButtonText("打开官网收银台")
				.setCta()
				.onClick(() => {
					try {
						openExternal(mobileCheckoutUrl());
						new Notice("已打开拾笔官网，请在官网登录后确认支付");
					} catch (error) {
						debugLog.error("[pickpen] 打开移动端收银台失败", error);
						new Notice("无法打开官网，请稍后重试");
					}
				}),
		);
	};

	const loadPricing = async () => {
		if (disposed) return;
		plansRoot.empty();
		plansRoot.createDiv({ cls: "pickpen-subscription-loading", text: "正在加载订阅方案…" });
		try {
			const reply = await requestPlans();
			if (disposed) return;
			plansRoot.empty();
			renderPricingLink(plansRoot, reply.pricingUrl);
			renderPurchase();
		} catch (error) {
			if (disposed) return;
			plansRoot.empty();
			const row = new Setting(plansRoot).setName("订阅价格说明加载失败").setDesc("网络不可达或服务端暂不可用");
			row.addButton((button) => button.setButtonText("重试").onClick(() => void loadPricing()));
			renderPurchase();
			debugLog.error("[pickpen] 订阅价格说明加载失败", error);
		}
	};

	const renderStatusError = () => {
		if (disposed) return;
		statusRoot.empty();
		const row = new Setting(statusRoot).setName("订阅加载失败").setDesc("网络不可达或服务端暂不可用");
		row.addButton((button) => button.setButtonText("重试").onClick(() => void loadStatus()));
	};

	const loadStatus = async () => {
		if (disposed) return;
		statusRoot.empty();
		if (!plugin.settings.accessToken) {
			new Setting(statusRoot).setName("当前档位").setDesc("请先在上方登录后查看订阅状态");
			return;
		}
		statusRoot.createDiv({ cls: "pickpen-subscription-loading", text: "正在加载订阅…" });
		try {
			const [plansReply, subscriptionReply] = await Promise.all([
				requestPlans(),
				plugin.client.subscriptionClient.getSubscription({}),
			]);
			if (disposed) return;
			statusRoot.empty();
			renderSubscriptionState(
				statusRoot,
				plansReply.plans,
				subscriptionReply.current,
				subscriptionReply.scheduled,
				subscriptionReply.storageBytes,
				subscriptionReply.vaultCount,
			);
		} catch (error) {
			renderStatusError();
			debugLog.error("[pickpen] 移动端订阅加载失败", error);
		}
	};

	void loadPricing();
	void loadStatus();
	return () => {
		disposed = true;
		statusRoot.remove();
		plansRoot.remove();
	};
}

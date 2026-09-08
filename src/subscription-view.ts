import { ButtonComponent, Modal, Notice, Setting } from "obsidian";
import QRCode from "qrcode";

import { debugLog } from "./debug-log";
import { Channel, type Order, type Plan } from "./gen/proto/subscription/subscription_pb";
import type PickpenPlugin from "./index";
import { ErrCode, errorCode } from "./remote-connect";
import { renderPricingLink } from "./subscription-pricing-link";
import { renderSubscriptionState } from "./subscription-state-view";

export function formatAmount(amount: bigint): string {
	const sign = amount < 0n ? "-" : "";
	const value = amount < 0n ? -amount : amount;
	return `${sign}¥${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

export function purchaseQuote(plan: Pick<Plan, "monthlyPrice" | "annualPrice">, billingCycle: "monthly" | "annual", quantity: bigint) {
	const unitPrice = billingCycle === "monthly" ? plan.monthlyPrice : plan.annualPrice;
	return {
		unitPrice,
		total: unitPrice * quantity,
		months: billingCycle === "monthly" ? quantity : quantity * 12n,
	};
}

type PurchaseQuantityPlan = Pick<
	Plan,
	"monthlyMinQuantity" | "monthlyMaxQuantity" | "annualMinQuantity" | "annualMaxQuantity"
>;

export function purchaseQuantityRange(plan: PurchaseQuantityPlan, billingCycle: "monthly" | "annual") {
	const min = billingCycle === "monthly" ? plan.monthlyMinQuantity : plan.annualMinQuantity;
	const max = billingCycle === "monthly" ? plan.monthlyMaxQuantity : plan.annualMaxQuantity;
	if (min <= 0n || max < min) return undefined;
	return { min, max };
}

export function clampPurchaseQuantity(quantity: bigint, range: { min: bigint; max: bigint }): bigint {
	if (quantity < range.min) return range.min;
	if (quantity > range.max) return range.max;
	return quantity;
}

/** 渲染桌面设置页订阅区域，并返回异步回写的清理函数。 */
export function renderSubscriptionSection(containerEl: HTMLElement, plugin: PickpenPlugin): () => void {
	let disposed = false;
	new Setting(containerEl).setHeading().setName("当前订阅");
	const statusRoot = containerEl.createDiv({ cls: "pickpen-subscription pickpen-subscription-status" });
	new Setting(containerEl).setHeading().setName("订阅方案");
	const plansRoot = containerEl.createDiv({ cls: "pickpen-subscription pickpen-subscription-plans" });

	if (!plugin.settings.accessToken) {
		new Setting(statusRoot).setName("登录后查看订阅").setDesc("请先在上方完成账号登录");
		const loadGuestPlans = async () => {
			if (disposed) return;
			plansRoot.empty();
			plansRoot.createDiv({ cls: "pickpen-subscription-loading", text: "正在加载订阅方案…" });
			try {
				const reply = await plugin.client.subscriptionClient.listPlans({});
				if (disposed) return;
				plansRoot.empty();
				renderPricingLink(plansRoot, reply.pricingUrl);
				new Setting(plansRoot).setName("登录后购买订阅").setDesc("请先在上方完成账号登录");
			} catch (error) {
				if (disposed) return;
				plansRoot.empty();
				const row = new Setting(plansRoot).setName("订阅加载失败").setDesc("网络不可达或服务端暂不可用");
				row.addButton((button) => button.setButtonText("重试").onClick(() => void loadGuestPlans()));
				debugLog.error(`[pickpen] 订阅方案加载失败，错误码：${errorCode(error) ?? "unknown"}`);
			}
		};
		void loadGuestPlans();
		return () => {
			disposed = true;
		};
	}

	const renderError = (message: string) => {
		if (disposed) return;
		statusRoot.empty();
		plansRoot.empty();
		const addRetry = (parent: HTMLElement) => {
			const row = new Setting(parent).setName("订阅加载失败").setDesc(message);
			row.addButton((button) => button.setButtonText("重试").onClick(() => void load()));
		};
		addRetry(statusRoot);
		addRetry(plansRoot);
	};

	const load = async () => {
		if (disposed) return;
		statusRoot.empty();
		plansRoot.empty();
		statusRoot.createDiv({ cls: "pickpen-subscription-loading", text: "正在加载当前订阅…" });
		plansRoot.createDiv({ cls: "pickpen-subscription-loading", text: "正在加载订阅方案…" });
		try {
			const [plansReply, subscriptionReply] = await Promise.all([
				plugin.client.subscriptionClient.listPlans({}),
				plugin.client.subscriptionClient.getSubscription({}),
			]);
			if (disposed) return;
			statusRoot.empty();
			plansRoot.empty();
			renderSubscriptionState(
				statusRoot,
				plansReply.plans,
				subscriptionReply.current,
				subscriptionReply.scheduled,
				subscriptionReply.storageBytes,
				subscriptionReply.vaultCount,
			);
			renderPurchase(plansRoot, plansReply.plans.filter((plan) => plan.purchasable), plansReply.pricingUrl);
		} catch (err) {
			renderError("网络不可达或服务端暂不可用");
			debugLog.error(`[pickpen] 订阅加载失败，错误码：${errorCode(err) ?? "unknown"}`);
		}
	};

	const renderPurchase = (parent: HTMLElement, plans: readonly Plan[], pricingURL: string) => {
		renderPricingLink(parent, pricingURL);
		if (plans.length === 0) {
			new Setting(parent).setName("暂无可购买档位");
			return;
		}
		if (plans.some((plan) => !purchaseQuantityRange(plan, "monthly") || !purchaseQuantityRange(plan, "annual"))) {
			new Setting(parent).setName("套餐配置不可用").setDesc("服务端未返回有效的购买数量范围，请稍后重试");
			return;
		}
		let selectedPlan = plans[0];
		let billingCycle: "monthly" | "annual" = "monthly";
		let paymentMethod: "wechat" | "alipay" = "wechat";
		const currentRange = () => purchaseQuantityRange(selectedPlan, billingCycle)!;
		let quantity = currentRange().min;
		let requestID = crypto.randomUUID();
		const price = parent.createDiv({ cls: "pickpen-subscription-price" });
		const updatePrice = () => {
			const quote = purchaseQuote(selectedPlan, billingCycle, quantity);
			const unit = billingCycle === "monthly" ? "月" : "年";
			price.textContent = `${selectedPlan.name} · ${formatAmount(quote.unitPrice)}/${unit} × ${quantity.toString()} · 合计 ${formatAmount(quote.total)}（${quote.months.toString()} 个月）`;
		};
		let quantitySetting!: Setting;
		let minusButton!: ButtonComponent;
		let plusButton!: ButtonComponent;
		let quantityText!: { setValue(value: string): unknown };
		const refreshQuantity = () => {
			const range = currentRange();
			quantity = clampPurchaseQuantity(quantity, range);
			quantityText.setValue(quantity.toString());
			minusButton.setDisabled(quantity <= range.min);
			plusButton.setDisabled(quantity >= range.max);
			const unit = billingCycle === "monthly" ? "个月" : "年";
			quantitySetting.setDesc(`服务端允许范围：${range.min.toString()}–${range.max.toString()} ${unit}`);
			requestID = crypto.randomUUID();
			updatePrice();
		};

		new Setting(parent).setName("订阅档位").addDropdown((dropdown) => {
			for (const plan of plans) dropdown.addOption(plan.id, plan.name);
			dropdown.setValue(selectedPlan.id).onChange((id) => {
				selectedPlan = plans.find((plan) => plan.id === id) ?? plans[0];
				refreshQuantity();
			});
		});
		new Setting(parent).setName("计费周期").addDropdown((dropdown) => {
			dropdown.addOption("monthly", "月付");
			dropdown.addOption("annual", "年付");
			dropdown.setValue(billingCycle).onChange((value) => {
				billingCycle = value === "annual" ? "annual" : "monthly";
				refreshQuantity();
			});
		});
		new Setting(parent).setName("支付方式").addDropdown((dropdown) => {
			dropdown.addOption("wechat", "微信支付");
			dropdown.addOption("alipay", "支付宝");
			dropdown.setValue(paymentMethod).onChange((value) => {
				paymentMethod = value === "alipay" ? "alipay" : "wechat";
				requestID = crypto.randomUUID();
			});
		});
		quantitySetting = new Setting(parent).setName("购买数量");
		quantitySetting.addButton((button) => {
			minusButton = button;
			button.setButtonText("−").setTooltip("减少").setDisabled(true).onClick(() => {
				if (quantity > currentRange().min) quantity -= 1n;
				refreshQuantity();
			});
		});
		quantitySetting.addText((text) => {
			quantityText = text;
			text.inputEl.addClass("pickpen-subscription-quantity");
			text.setValue("1").setDisabled(true);
		});
		quantitySetting.addButton((button) => {
			plusButton = button;
			button.setButtonText("+").setTooltip("增加").onClick(() => {
				if (quantity < currentRange().max) quantity += 1n;
				refreshQuantity();
			});
		});
		refreshQuantity();

		const purchase = new Setting(parent).setName("扫码支付").setDesc("付款后新订阅将从现有订阅队列末尾开始生效");
		let busy = false;
		purchase.addButton((button) =>
			button
				.setButtonText("购买")
				.setCta()
				.onClick(async () => {
					if (busy) return;
					busy = true;
					button.setDisabled(true).setButtonText("创建订单中…");
					try {
						const channel = paymentMethod === "wechat" ? Channel.WECHAT_NATIVE : Channel.ALIPAY_WAP_QR_CODE;
						const reply = await plugin.client.subscriptionClient.createOrder({
							planId: selectedPlan.id,
							billingCycle,
							quantity,
							channel,
							requestId: requestID,
						});
						if (
							!reply.order ||
							reply.order.channel !== channel ||
							!reply.qrCode?.content ||
							reply.redirect
						) {
							throw new Error("订单未返回有效付款码");
						}
						requestID = crypto.randomUUID();
						new SubscriptionPaymentModal(plugin, reply.order, reply.qrCode.content, selectedPlan.name, paymentMethod, () => void load()).open();
					} catch (err) {
						const message = purchaseErrorMessage(err);
						purchase.setErrorMessage(message);
						new Notice(message);
					} finally {
						busy = false;
						button.setDisabled(false).setButtonText("购买");
					}
				}),
		);
	};

	void load();
	return () => {
		disposed = true;
	};
}

class SubscriptionPaymentModal extends Modal {
	private readonly plugin: PickpenPlugin;
	private readonly order: Order;
	private readonly qrCodeContent: string;
	private readonly planName: string;
	private readonly paymentMethod: "wechat" | "alipay";
	private readonly onPaid: () => void;
	private countdownTimer: number | null = null;
	private pollTimer: number | null = null;
	private polling = false;
	private disposed = false;

	constructor(plugin: PickpenPlugin, order: Order, qrCodeContent: string, planNameValue: string, paymentMethod: "wechat" | "alipay", onPaid: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.order = order;
		this.qrCodeContent = qrCodeContent;
		this.planName = planNameValue;
		this.paymentMethod = paymentMethod;
		this.onPaid = onPaid;
		this.modalEl.classList.add("pickpen-subscription-payment-modal");
	}

	onOpen(): void {
		const paymentName = this.paymentMethod === "wechat" ? "微信支付" : "支付宝";
		this.setTitle(`${paymentName}扫码支付`);
		const summary = this.contentEl.createDiv({ cls: "pickpen-payment-summary" });
		const cycle = this.order.billingCycle === "annual" ? "年付" : "月付";
		summary.createDiv({ text: `${this.planName} · ${cycle} × ${this.order.quantity.toString()} · ${this.order.months.toString()} 个月` });
		summary.createDiv({ cls: "pickpen-payment-amount", text: formatAmount(this.order.amount) });
		const canvas = this.contentEl.createEl("canvas", { cls: "pickpen-payment-qr" });
		canvas.setAttribute("aria-label", `${paymentName}付款二维码`);
		const status = this.contentEl.createDiv({ cls: "pickpen-payment-status", text: `请使用${paymentName}扫码付款` });
		const countdown = this.contentEl.createDiv({ cls: "pickpen-payment-countdown" });

		void QRCode.toCanvas(canvas, this.qrCodeContent, { width: 260, margin: 2, errorCorrectionLevel: "M" }).catch(() => {
			status.textContent = "付款码生成失败，请关闭后重试";
			this.stopTimers();
		});

		const renderCountdown = () => {
			const seconds = Math.max(0, Math.ceil((Number(this.order.expiresAtMs) - Date.now()) / 1000));
			const minutesPart = Math.floor(seconds / 60).toString().padStart(2, "0");
			const secondsPart = (seconds % 60).toString().padStart(2, "0");
			countdown.textContent = `订单剩余 ${minutesPart}:${secondsPart}`;
			if (seconds === 0) {
				status.textContent = "订单已失效，请关闭后重新购买";
				this.stopTimers();
			}
		};
		renderCountdown();
		this.countdownTimer = window.setInterval(renderCountdown, 1000);

		const poll = async () => {
			if (this.disposed || this.polling) return;
			this.polling = true;
			try {
				const reply = await this.plugin.client.subscriptionClient.getOrder({ orderId: this.order.id });
				if (this.disposed || !reply.order) return;
				if (reply.order.status === "paid") {
					status.textContent = "支付成功，订阅已排期";
					status.classList.add("is-success");
					countdown.empty();
					this.stopTimers();
					new Notice("支付成功，订阅已生效或加入待生效队列");
					this.onPaid();
				} else if (reply.order.status === "expired" || reply.order.status === "closed") {
					status.textContent = "订单已失效，请关闭后重新购买";
					this.stopTimers();
				}
			} catch (err) {
				debugLog.warn(`[pickpen] 查询订阅订单状态失败，错误码：${errorCode(err) ?? "unknown"}`);
			} finally {
				this.polling = false;
			}
		};
		void poll();
		this.pollTimer = window.setInterval(() => void poll(), 2000);

		new ButtonComponent(this.contentEl.createDiv({ cls: "pickpen-payment-actions" }))
			.setButtonText("关闭")
			.onClick(() => this.close());
	}

	onClose(): void {
		this.disposed = true;
		this.stopTimers();
		this.contentEl.empty();
	}

	private stopTimers(): void {
		if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
		if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
		this.countdownTimer = null;
		this.pollTimer = null;
	}
}

function purchaseErrorMessage(err: unknown): string {
	switch (errorCode(err)) {
		case ErrCode.InvalidSubscription:
			return "购买参数无效，请重新选择";
		case ErrCode.PaymentUnavailable:
			return "所选支付渠道暂不可用";
		case ErrCode.OrderExpired:
			return "订单已失效，请重新购买";
		case ErrCode.PaymentCreateFailed:
			return "创建付款码失败，请稍后重试";
		default:
			return "创建订单失败：网络不可达或服务端异常";
	}
}

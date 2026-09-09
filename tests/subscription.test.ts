import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { PlanSchema, SubscriptionSchema } from "../src/gen/proto/subscription/subscription_pb";
import { resolvePricingURL } from "../src/subscription-pricing-link";
import { formatQuotaBytes, subscriptionQuotaRows } from "../src/subscription-state-view";
import {
	clampPurchaseQuantity,
	formatAmount,
	formatDiscount,
	normalizePurchaseDiscountPercent,
	purchaseQuantityRange,
	purchaseQuote,
	shouldDisplayPurchaseDiscount,
} from "../src/subscription-view";

describe("订阅价格说明地址", () => {
	it("接受服务端下发的绝对 HTTPS 地址", () => {
		expect(resolvePricingURL("https://pricing.example.com/plans")).toBe("https://pricing.example.com/plans");
		expect(resolvePricingURL("  https://pricing.example.com/plans?from=plugin  ")).toBe(
			"https://pricing.example.com/plans?from=plugin",
		);
	});

	it("拒绝空值、非法地址和非 HTTPS 协议", () => {
		expect(resolvePricingURL("")).toBeUndefined();
		expect(resolvePricingURL("/pricing")).toBeUndefined();
		expect(resolvePricingURL("not-a-url")).toBeUndefined();
		expect(resolvePricingURL("http://pricing.example.com/plans")).toBeUndefined();
		expect(resolvePricingURL("javascript:alert(1)")).toBeUndefined();
	});
});

describe("订阅金额格式", () => {
	it("以整数分稳定格式化，不使用浮点数", () => {
		expect(formatAmount(1n)).toBe("¥0.01");
		expect(formatAmount(2000n)).toBe("¥20.00");
		expect(formatAmount(36000n)).toBe("¥360.00");
	});
});

describe("订阅周期报价", () => {
	const plan = { monthlyPrice: 2000n, annualPrice: 20000n };
	it("月付按月数计价并对整笔原价打折", () => {
		expect(purchaseQuote(plan, "monthly", 3n, 80n)).toEqual({
			unitPrice: 2000n,
			originalTotal: 6000n,
			total: 4800n,
			months: 3n,
		});
	});
	it("年付按年数计价并换算月份", () => {
		expect(purchaseQuote(plan, "annual", 2n, 80n)).toEqual({
			unitPrice: 20000n,
			originalTotal: 40000n,
			total: 32000n,
			months: 24n,
		});
	});
	it("对整笔金额四舍五入到分", () => {
		expect(purchaseQuote({ monthlyPrice: 101n, annualPrice: 0n }, "monthly", 3n, 80n).total).toBe(242n);
	});
	it("折扣为 100 时保持原价", () => {
		expect(purchaseQuote(plan, "monthly", 3n, 100n).total).toBe(6000n);
	});
});

describe("订阅折扣配置", () => {
	it("将旧服务端的默认值 0 兼容为无折扣", () => {
		expect(normalizePurchaseDiscountPercent(0)).toBe(100n);
		expect(normalizePurchaseDiscountPercent(100)).toBe(100n);
		expect(shouldDisplayPurchaseDiscount(100n)).toBe(false);
	});

	it("接受有效折扣并生成中文折扣标签", () => {
		expect(normalizePurchaseDiscountPercent(80)).toBe(80n);
		expect(shouldDisplayPurchaseDiscount(80n)).toBe(true);
		expect(formatDiscount(80n)).toBe("8 折");
		expect(formatDiscount(85n)).toBe("8.5 折");
	});

	it("拒绝超出范围或非整数的折扣", () => {
		expect(normalizePurchaseDiscountPercent(-1)).toBeUndefined();
		expect(normalizePurchaseDiscountPercent(101)).toBeUndefined();
		expect(normalizePurchaseDiscountPercent(80.5)).toBeUndefined();
	});
});

describe("服务端购买数量范围", () => {
	const plan = {
		monthlyMinQuantity: 2n,
		monthlyMaxQuantity: 20n,
		annualMinQuantity: 3n,
		annualMaxQuantity: 10n,
	};

	it("按计费周期读取服务端返回的范围", () => {
		expect(purchaseQuantityRange(plan, "monthly")).toEqual({ min: 2n, max: 20n });
		expect(purchaseQuantityRange(plan, "annual")).toEqual({ min: 3n, max: 10n });
	});

	it("切换周期后将数量限制在服务端范围内", () => {
		expect(clampPurchaseQuantity(1n, { min: 2n, max: 20n })).toBe(2n);
		expect(clampPurchaseQuantity(12n, { min: 3n, max: 10n })).toBe(10n);
		expect(clampPurchaseQuantity(5n, { min: 3n, max: 10n })).toBe(5n);
	});

	it("拒绝缺失或非法范围", () => {
		expect(purchaseQuantityRange({ ...plan, monthlyMinQuantity: 0n }, "monthly")).toBeUndefined();
		expect(purchaseQuantityRange({ ...plan, annualMaxQuantity: 2n }, "annual")).toBeUndefined();
	});
});

describe("当前订阅额度", () => {
	const plans = [
		create(PlanSchema, {
			id: "free",
			name: "Free",
			storageLimitBytes: 30n * 1024n * 1024n,
			vaultLimit: 1n,
			maxFileSizeBytes: 5n * 1024n * 1024n,
			historyRetentionDays: 10n,
		}),
		create(PlanSchema, {
			id: "pro",
			name: "Pro",
			storageLimitBytes: 1024n * 1024n * 1024n,
			vaultLimit: 3n,
			maxFileSizeBytes: 30n * 1024n * 1024n,
			historyRetentionMonths: 3n,
		}),
	];

	it("按二进制单位格式化存储额度", () => {
		expect(formatQuotaBytes(0n)).toBe("0 B");
		expect(formatQuotaBytes(1536n)).toBe("1.5 KB");
		expect(formatQuotaBytes(30n * 1024n * 1024n)).toBe("30 MB");
		expect(formatQuotaBytes(1024n * 1024n * 1024n)).toBe("1 GB");
	});

	it("无付费订阅时展示 Free 用量和额度", () => {
		expect(subscriptionQuotaRows(plans, undefined, 1572864n, 1n)).toEqual([
			{ label: "存储空间", value: "1.5 MB / 30 MB" },
			{ label: "仓库数量", value: "1 / 1 个" },
			{ label: "单文件上限", value: "5 MB" },
			{ label: "版本历史", value: "10 天" },
		]);
	});

	it("按当前付费套餐展示月度历史保留期", () => {
		const current = create(SubscriptionSchema, { planId: "pro" });
		expect(subscriptionQuotaRows(plans, current, 12n * 1024n * 1024n, 2n)).toEqual([
			{ label: "存储空间", value: "12 MB / 1 GB" },
			{ label: "仓库数量", value: "2 / 3 个" },
			{ label: "单文件上限", value: "30 MB" },
			{ label: "版本历史", value: "3 个月" },
		]);
	});

	it("套餐额度缺失时不把协议默认零值误当作真实额度", () => {
		const current = create(SubscriptionSchema, { planId: "legacy" });
		expect(subscriptionQuotaRows(plans, current, 0n, 0n).map((row) => row.value)).toEqual([
			"暂不可用",
			"暂不可用",
			"暂不可用",
			"暂不可用",
		]);
	});
});

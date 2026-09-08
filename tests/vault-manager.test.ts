import { describe, expect, it } from "vitest";

import { formatVaultQuota, resolveVaultQuota } from "../src/vault-manager";

describe("仓库管理额度", () => {
	const plans = [
		{ id: "free", vaultLimit: 1n },
		{ id: "pro", vaultLimit: 3n },
	];

	it("无付费订阅时使用 Free 档位", () => {
		expect(resolveVaultQuota(plans, undefined, 1n)).toEqual({ count: 1n, limit: 1n, atLimit: true });
	});

	it("按当前付费档位计算是否达到上限", () => {
		expect(resolveVaultQuota(plans, "pro", 2n)).toEqual({ count: 2n, limit: 3n, atLimit: false });
		expect(resolveVaultQuota(plans, "pro", 3n)).toEqual({ count: 3n, limit: 3n, atLimit: true });
	});

	it("缺少有效套餐或用量时返回暂不可用", () => {
		expect(resolveVaultQuota(plans, "legacy", 0n)).toBeUndefined();
		expect(resolveVaultQuota([{ id: "free", vaultLimit: 0n }], undefined, 0n)).toBeUndefined();
		expect(resolveVaultQuota(plans, undefined, -1n)).toBeUndefined();
		expect(formatVaultQuota(undefined)).toBe("仓库数量：暂不可用");
	});

	it("按已创建数量和总上限格式化顶部文案", () => {
		expect(formatVaultQuota({ count: 2n, limit: 3n, atLimit: false })).toBe(
			"仓库数量：2 / 3 个（已创建 / 总上限）",
		);
	});
});

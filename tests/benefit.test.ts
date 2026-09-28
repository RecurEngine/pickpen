import { beforeEach, describe, expect, it } from "vitest";

import { benefitActivityOpen, benefitCodeLength, resetBenefitActivity } from "../src/benefit-state";
import { benefitClaimText, benefitDurationText, benefitErrorMessage, formatBenefitDate } from "../src/benefit-view";
import { ErrCode } from "../src/remote-connect";

const err = (code: number) => ({ code });

describe("福利码时长文案", () => {
	it("月数与天数二选一", () => {
		expect(benefitDurationText(1n, 0n)).toBe("1 个月");
		expect(benefitDurationText(12n, 0n)).toBe("12 个月");
		expect(benefitDurationText(0n, 7n)).toBe("7 天");
	});

	it("异常数据（都非正）退化为空串", () => {
		expect(benefitDurationText(0n, 0n)).toBe("");
	});
});

describe("福利码到期时间", () => {
	it("只展示到日", () => {
		// 本地时区构造，避免断言依赖运行环境的时区
		const ms = new Date(2026, 9, 28, 13, 45).getTime();
		expect(formatBenefitDate(BigInt(ms))).toBe("2026-10-28");
	});

	it("缺失时间戳返回空串", () => {
		expect(formatBenefitDate(0n)).toBe("");
	});
});

describe("领取成功提示", () => {
	it("月度：只陈述获得与到期，不声称升级档位", () => {
		const endsAt = BigInt(new Date(2026, 9, 28, 13, 45).getTime());
		expect(benefitClaimText("pro", 1n, 0n, endsAt)).toBe("已获得 1 个月 Pro 会员，有效期至 2026-10-28");
		expect(benefitClaimText("max", 3n, 0n, endsAt)).toBe("已获得 3 个月 Max 会员，有效期至 2026-10-28");
	});

	it("按天发放", () => {
		const endsAt = BigInt(new Date(2026, 9, 28, 13, 45).getTime());
		expect(benefitClaimText("pro", 0n, 7n, endsAt)).toBe("已获得 7 天 Pro 会员，有效期至 2026-10-28");
	});

	it("到期时间缺失时省略有效期", () => {
		expect(benefitClaimText("pro", 1n, 0n, 0n)).toBe("已获得 1 个月 Pro 会员");
	});

	it("时长缺失时退化为通用文案", () => {
		expect(benefitClaimText("", 0n, 0n, 0n)).toBe("福利码领取成功");
	});
});

describe("福利码错误文案", () => {
	it("按错误码给出可操作提示", () => {
		expect(benefitErrorMessage(err(ErrCode.BenefitCodeUnavailable))).toBe("福利码无效或已下架，请检查后重试");
		expect(benefitErrorMessage(err(ErrCode.BenefitCodeExpired))).toBe("该福利码不在活动期内");
		expect(benefitErrorMessage(err(ErrCode.BenefitRequestInvalid))).toBe("福利码格式不正确");
		expect(benefitErrorMessage(err(ErrCode.BenefitTooFrequent))).toBe("尝试过于频繁，请稍后再试");
		expect(benefitErrorMessage(err(ErrCode.InvalidOrMissingCredentials))).toBe("登录已失效，请重新登录");
	});

	it("已领取过是状态陈述而非失败：并发重复提交时用户也会看到它", () => {
		const message = benefitErrorMessage(err(ErrCode.BenefitAlreadyClaimed));
		expect(message).toBe("该福利码你已领取过，同一福利码限领一次");
		expect(message).not.toContain("失败");
	});

	it("未知错误回落网络文案", () => {
		expect(benefitErrorMessage(new Error("boom"))).toBe("领取失败：网络不可达或服务端异常");
		expect(benefitErrorMessage(undefined)).toBe("领取失败：网络不可达或服务端异常");
	});
});

describe("福利码活动状态", () => {
	beforeEach(() => {
		resetBenefitActivity();
	});

	it("未知与关闭都不展示入口", () => {
		expect(benefitActivityOpen()).toBe(false);
	});

	it("福利码长度有默认值兜底", () => {
		expect(benefitCodeLength()).toBe(6);
	});
});

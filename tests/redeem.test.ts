import { describe, expect, it } from "vitest";

import { isRedeemCodeCandidate, normalizeRedeemCodeInput, sanitizeRedeemCodeInput } from "../src/redeem-code";
import { redeemErrorMessage, redeemSuccessText } from "../src/redeem-view";
import { ErrCode } from "../src/remote-connect";

const err = (code: number) => ({ code });

describe("兑换码输入清洗", () => {
	it("转大写、去空白与连字符", () => {
		expect(sanitizeRedeemCodeInput(" pp-ab12 cd34-ef56-gh78 ")).toBe("PPAB12CD34EF56GH78");
	});

	it("I/L 映射为 1、O 映射为 0", () => {
		expect(sanitizeRedeemCodeInput("il-o")).toBe("110");
	});

	it("提交前剥离可选的 PP 前缀", () => {
		expect(normalizeRedeemCodeInput("PP-AB12-CD34-EF56-GH78")).toBe("AB12CD34EF56GH78");
		expect(normalizeRedeemCodeInput("ab12cd34ef56gh78")).toBe("AB12CD34EF56GH78");
	});

	it("16 位载荷即使以 PP 开头也不误剥", () => {
		expect(normalizeRedeemCodeInput("PPABCDEFGHJKMNPQ")).toBe("PPABCDEFGHJKMNPQ");
	});

	it("候选校验只认 16 位 Crockford 字符", () => {
		expect(isRedeemCodeCandidate("AB12CD34EF56GH78")).toBe(true);
		expect(isRedeemCodeCandidate("UUUUUUUUUUUUUUUU")).toBe(false);
		expect(isRedeemCodeCandidate("AB12")).toBe(false);
		expect(isRedeemCodeCandidate("AB12CD34EF56GH7-")).toBe(false);
	});
});

describe("兑换成功提示", () => {
	const endsAt = BigInt(new Date(2026, 9, 28, 13, 45).getTime());

	it("首次兑换陈述获得与到期", () => {
		expect(
			redeemSuccessText({ planId: "pro", months: 1n, endsAtMs: endsAt, alreadyRedeemedByMe: false }),
		).toBe("已获得 1 个月 Pro 会员，有效期至 2026-10-28");
		expect(
			redeemSuccessText({ planId: "max", months: 12n, endsAtMs: endsAt, alreadyRedeemedByMe: false }),
		).toBe("已获得 12 个月 Max 会员，有效期至 2026-10-28");
	});

	it("同用户幂等回放不声称再次发放", () => {
		const message = redeemSuccessText({ planId: "pro", months: 1n, endsAtMs: endsAt, alreadyRedeemedByMe: true });
		expect(message).toBe("该兑换码你已兑换过，本次未重复发放");
		expect(message).not.toContain("已获得");
	});
});

describe("兑换码错误文案", () => {
	it("按错误码给出可操作提示", () => {
		expect(redeemErrorMessage(err(ErrCode.RedeemCodeUnavailable))).toBe("兑换码无效或已作废，请检查后重试");
		expect(redeemErrorMessage(err(ErrCode.RedeemCodeUsed))).toBe("该兑换码已被使用");
		expect(redeemErrorMessage(err(ErrCode.RedeemRequestInvalid))).toBe("兑换码格式不正确");
		expect(redeemErrorMessage(err(ErrCode.RedeemTooFrequent))).toBe("尝试过于频繁，请稍后再试");
		expect(redeemErrorMessage(err(ErrCode.InvalidOrMissingCredentials))).toBe("登录已失效，请重新登录");
	});

	it("未知错误回落网络文案", () => {
		expect(redeemErrorMessage(new Error("boom"))).toBe("兑换失败：网络不可达或服务端异常");
		expect(redeemErrorMessage(undefined)).toBe("兑换失败：网络不可达或服务端异常");
	});
});

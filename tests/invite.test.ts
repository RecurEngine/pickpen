import { describe, expect, it } from "vitest";

import { formatInviteTime, inviteErrorMessage, inviteProgressRows, inviteRewardText } from "../src/invite-view";
import { ErrCode } from "../src/remote-connect";

describe("邀请进度行", () => {
	it("上限为 0 时显示当前不可邀请", () => {
		expect(inviteProgressRows(0n, 3n, 1n)).toEqual([
			{ label: "邀请人数", value: "当前不可邀请" },
			{ label: "邀请充值", value: "1 人" },
		]);
	});

	it("显示已邀请人数与上限", () => {
		expect(inviteProgressRows(20n, 3n, 2n)).toEqual([
			{ label: "邀请人数", value: "3 / 20" },
			{ label: "邀请充值", value: "2 人" },
		]);
	});
});

describe("邀请奖励说明", () => {
	it("按服务端下发的时长拼接", () => {
		expect(inviteRewardText(7n, 1n)).toBe("每邀请 1 位好友注册得 7 天 Pro，好友首次付费再得 1 个月 Pro");
	});

	it("只下发其中一项时只展示该项", () => {
		expect(inviteRewardText(7n, 0n)).toBe("每邀请 1 位好友注册得 7 天 Pro");
		expect(inviteRewardText(0n, 1n)).toBe("好友首次付费再得 1 个月 Pro");
	});

	it("服务端未下发时长时返回空串（不展示说明）", () => {
		expect(inviteRewardText(0n, 0n)).toBe("");
	});
});

describe("邀请信息错误文案", () => {
	it("分页参数非法", () => {
		expect(inviteErrorMessage({ code: ErrCode.InviteRequestInvalid })).toContain("参数非法");
	});

	it("未知错误按网络兜底", () => {
		expect(inviteErrorMessage(new Error("boom"))).toContain("网络不可达");
	});
});

describe("邀请列表时间", () => {
	it("0 显示占位符", () => {
		expect(formatInviteTime(0n)).toBe("—");
	});

	it("格式化到分钟", () => {
		const local = new Date(2026, 8, 17, 9, 5).getTime();
		expect(formatInviteTime(BigInt(local))).toBe("2026-09-17 09:05");
	});
});

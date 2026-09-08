import { describe, expect, it } from "vitest";

import { localDateKey } from "../src/storage-limit-alert";

describe("存储已满提醒", () => {
	it("提醒日期使用本地年月日，不受 ISO UTC 日期影响", () => {
		const date = new Date(2026, 8, 4, 23, 59, 0);
		expect(localDateKey(date)).toBe("2026-09-04");
	});
});

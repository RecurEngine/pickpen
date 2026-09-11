import { describe, expect, it } from "vitest";

import { setupStage } from "../src/setup-guide";

describe("首次使用引导阶段判定", () => {
	it("全新未登录时引导登录", () => {
		expect(setupStage({ accessToken: "", vaultId: "" })).toBe("login");
	});

	it("未登录但残留绑定时仍引导登录（无账号时选择仓库没有意义）", () => {
		expect(setupStage({ accessToken: "", vaultId: "3" })).toBe("login");
	});

	it("已登录未绑定仓库时引导绑定", () => {
		expect(setupStage({ accessToken: "token", vaultId: "" })).toBe("bind");
	});

	it("已登录且已绑定时不引导", () => {
		expect(setupStage({ accessToken: "token", vaultId: "3" })).toBeNull();
	});
});

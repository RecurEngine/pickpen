// 自动解锁弹窗的判定：何时弹、弹哪套文案、同一密钥版本只弹一次。
import { describe, expect, it } from "vitest";

import {
	resolveAutoUnlockPrompt,
	UNLOCK_COPY_ENABLED,
	UNLOCK_COPY_KEY_CHANGED,
	UNLOCK_COPY_NEED_KEY,
	unlockPromptKey,
	type AutoUnlockPromptInput,
} from "../src/crypto/unlock-prompt";

/** 默认输入：仓库 7 的密钥版本 1，本机未解锁且从未提示过 */
function input(overrides: Partial<AutoUnlockPromptInput> = {}): AutoUnlockPromptInput {
	return {
		switched: false,
		locked: true,
		keyChanged: false,
		wasEncrypted: true,
		vaultId: "7",
		keyVersion: "1",
		promptedKey: "",
		...overrides,
	};
}

describe("自动解锁弹窗判定", () => {
	it("换绑与已解锁都不弹", () => {
		expect(resolveAutoUnlockPrompt(input({ switched: true }))).toBeNull();
		expect(resolveAutoUnlockPrompt(input({ locked: false }))).toBeNull();
	});

	it("本机无可用密钥：弹「需要解锁」，键为 仓库:密钥版本", () => {
		const decision = resolveAutoUnlockPrompt(input());
		expect(decision?.copy).toBe(UNLOCK_COPY_NEED_KEY);
		expect(decision?.key).toBe("7:1");
	});

	it("远端改了密码：弹「密码已在其他设备变更」", () => {
		expect(resolveAutoUnlockPrompt(input({ keyChanged: true }))?.copy).toBe(UNLOCK_COPY_KEY_CHANGED);
	});

	it("对方把明文仓库转为加密：弹「仓库已启用端到端加密」，不是「密码变更」", () => {
		const decision = resolveAutoUnlockPrompt(input({ keyChanged: true, wasEncrypted: false }));
		expect(decision?.copy).toBe(UNLOCK_COPY_ENABLED);
		expect(decision?.copy).not.toBe(UNLOCK_COPY_KEY_CHANGED);
	});

	it("本机首次见到加密仓库（密钥未变过）：仍是「需要解锁」", () => {
		expect(resolveAutoUnlockPrompt(input({ keyChanged: false, wasEncrypted: false }))?.copy).toBe(
			UNLOCK_COPY_NEED_KEY,
		);
	});

	it("同一密钥版本已提示过：不再弹（用户取消后不每轮打扰）", () => {
		expect(resolveAutoUnlockPrompt(input({ promptedKey: "7:1" }))).toBeNull();
	});

	it("密钥版本变化后重新武装：对方再次改密码仍会提示", () => {
		const decision = resolveAutoUnlockPrompt(input({ keyChanged: true, keyVersion: "2", promptedKey: "7:1" }));
		expect(decision?.key).toBe("7:2");
		expect(decision?.copy).toBe(UNLOCK_COPY_KEY_CHANGED);
	});

	it("换仓库后重新武装：键取自仓库 ID", () => {
		expect(resolveAutoUnlockPrompt(input({ vaultId: "8", promptedKey: "7:1" }))?.key).toBe("8:1");
	});

	it("三套文案互不相同（防复制粘贴写重）", () => {
		const copies = [UNLOCK_COPY_NEED_KEY, UNLOCK_COPY_ENABLED, UNLOCK_COPY_KEY_CHANGED];
		expect(new Set(copies.map((c) => c.title)).size).toBe(copies.length);
		expect(new Set(copies.map((c) => c.description)).size).toBe(copies.length);
	});

	it("unlockPromptKey 由仓库 ID 与密钥版本共同决定", () => {
		expect(unlockPromptKey("7", "1")).toBe("7:1");
		expect(unlockPromptKey("7", "2")).not.toBe(unlockPromptKey("7", "1"));
	});
});

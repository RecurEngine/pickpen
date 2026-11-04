// 绑定归属判定：覆盖「切换账号后残留旧绑定」与「老 data.json 无 owner」两类关键分支。
import { describe, expect, it } from "vitest";

import {
	bindingOwnerMatches,
	evaluateLoginBinding,
	needsOwnershipVerification,
	resolveVaultListBinding,
	type LoginBindingInput,
} from "../src/vault-binding";

function input(overrides: Partial<LoginBindingInput> = {}): LoginBindingInput {
	return {
		email: "b@example.com",
		vaultId: "76",
		vaultName: "兼收并蓄",
		owner: { vaultId: "76", email: "a@example.com" },
		sessionBinding: { vaultId: "76", email: "a@example.com" },
		...overrides,
	};
}

describe("bindingOwnerMatches / needsOwnershipVerification", () => {
	it("邮箱大小写与空白不影响归属判断", () => {
		expect(bindingOwnerMatches({ vaultId: "76", email: " A@Example.com " }, "76", "a@example.com")).toBe(true);
		expect(bindingOwnerMatches({ vaultId: "76", email: "a@example.com" }, "77", "a@example.com")).toBe(false);
		expect(bindingOwnerMatches(undefined, "76", "a@example.com")).toBe(false);
	});

	it("owner 能证明归属时不需要核验；缺失或冲突时需要", () => {
		expect(needsOwnershipVerification(input({ owner: { vaultId: "76", email: "b@example.com" } }))).toBe(false);
		expect(needsOwnershipVerification(input())).toBe(true);
		expect(needsOwnershipVerification(input({ owner: undefined }))).toBe(true);
		expect(needsOwnershipVerification(input({ vaultId: "" }))).toBe(false);
	});
});

describe("evaluateLoginBinding", () => {
	it("未绑定：进入选择流程且无需清理", () => {
		expect(evaluateLoginBinding(input({ vaultId: "" }), null)).toEqual({ kind: "select", clear: false });
	});

	it("owner 匹配：直接沿用，不依赖列表结果", () => {
		const owner = { vaultId: "76", email: "b@example.com" };
		expect(evaluateLoginBinding(input({ owner }), null)).toEqual({
			kind: "adopt",
			writeOwner: false,
			name: "兼收并蓄",
		});
	});

	it("owner 缺失 + 列表命中：补写归属并沿用列表里的名字", () => {
		expect(evaluateLoginBinding(input({ owner: undefined, vaultName: "旧名" }), [{ vaultId: "76", name: "兼收并蓄" }])).toEqual({
			kind: "adopt",
			writeOwner: true,
			name: "兼收并蓄",
		});
	});

	it("owner 缺失 + 列表未命中：解绑重选", () => {
		expect(evaluateLoginBinding(input({ owner: undefined }), [{ vaultId: "99", name: "别的仓库" }])).toEqual({
			kind: "select",
			clear: true,
		});
	});

	it("owner 属于 A + 当前 B + 列表未命中：解绑重选（线上场景）", () => {
		expect(evaluateLoginBinding(input(), [{ vaultId: "99", name: "兼收并蓄" }])).toEqual({
			kind: "select",
			clear: true,
		});
	});

	it("owner 属于 A + 当前 B + 列表命中：以服务端为准，补写归属", () => {
		expect(evaluateLoginBinding(input(), [{ vaultId: "76", name: "兼收并蓄" }])).toEqual({
			kind: "adopt",
			writeOwner: true,
			name: "兼收并蓄",
		});
	});

	it("列表失败 + owner 缺失 + 会话记忆匹配：沿用并补归属", () => {
		expect(
			evaluateLoginBinding(
				input({ owner: undefined, sessionBinding: { vaultId: "76", email: "b@example.com" } }),
				null,
			),
		).toEqual({
			kind: "adopt",
			writeOwner: true,
			name: "兼收并蓄",
		});
	});

	it("列表失败 + owner 缺失 + 无会话记忆：解绑重选", () => {
		expect(evaluateLoginBinding(input({ owner: undefined, sessionBinding: null }), null)).toEqual({
			kind: "select",
			clear: true,
		});
	});

	it("列表失败 + owner 属于其他账号 + 会话记忆匹配：owner 优先，解绑重选", () => {
		expect(
			evaluateLoginBinding(
				input({
					owner: { vaultId: "76", email: "a@example.com" },
					sessionBinding: { vaultId: "76", email: "b@example.com" },
				}),
				null,
			),
		).toEqual({ kind: "select", clear: true });
	});
});

describe("resolveVaultListBinding", () => {
	it("未绑定：不涉及解绑", () => {
		expect(resolveVaultListBinding("", [])).toEqual({ bound: false, stale: false });
	});

	it("列表加载失败：保持绑定，绝不解绑", () => {
		expect(resolveVaultListBinding("76", null)).toEqual({ bound: true, stale: false });
	});

	it("列表成功但不含该仓库：判定失效", () => {
		expect(resolveVaultListBinding("76", [{ vaultId: "99" }])).toEqual({ bound: false, stale: true });
		expect(resolveVaultListBinding("76", [])).toEqual({ bound: false, stale: true });
	});

	it("列表成功且包含该仓库：绑定有效", () => {
		expect(resolveVaultListBinding("76", [{ vaultId: "76" }, { vaultId: "99" }])).toEqual({
			bound: true,
			stale: false,
		});
	});
});

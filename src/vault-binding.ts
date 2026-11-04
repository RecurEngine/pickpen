// 绑定归属判定（纯函数）：登录后 / 仓库列表加载成功后核验本地 vaultId 是否仍属于当前账号。
// 绑定主键是 vaultId；vaultOwner 是绑定时写下的归属证明，随 data.json 跨端共享。

import type { VaultInfo } from "./types";

export interface BindingOwner {
	vaultId: string;
	email: string;
}

export interface LoginBindingInput {
	email: string;
	vaultId: string;
	vaultName: string;
	owner?: BindingOwner;
	/** 本会话绑定记忆（内存）；仅在列表核验失败时作为老 data.json 的兜底证据 */
	sessionBinding: BindingOwner | null;
}

export type LoginBindingDecision =
	| { kind: "adopt"; writeOwner: boolean; name: string }
	| { kind: "select"; clear: boolean };

function sameEmail(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** owner 是否证明该 vaultId 属于当前账号（邮箱大小写不敏感） */
export function bindingOwnerMatches(owner: BindingOwner | undefined, vaultId: string, email: string): boolean {
	return !!owner && owner.vaultId === vaultId && sameEmail(owner.email, email);
}

/** 有绑定、但 owner 不能证明归属：需要向服务端核验 */
export function needsOwnershipVerification(input: LoginBindingInput): boolean {
	return input.vaultId !== "" && !bindingOwnerMatches(input.owner, input.vaultId, input.email);
}

/**
 * 登录后的绑定决策。
 * listed === null 表示 ListVaults 失败：只在「owner 缺失 + 本会话记忆匹配」时沿用；
 * 明确的「owner 属于其他账号」优先于会话记忆。
 */
export function evaluateLoginBinding(
	input: LoginBindingInput,
	listed: readonly Pick<VaultInfo, "vaultId" | "name">[] | null,
): LoginBindingDecision {
	if (!input.vaultId) return { kind: "select", clear: false };
	if (bindingOwnerMatches(input.owner, input.vaultId, input.email)) {
		return { kind: "adopt", writeOwner: false, name: input.vaultName };
	}
	if (listed === null) {
		const sessionMatches =
			input.owner === undefined &&
			input.sessionBinding?.vaultId === input.vaultId &&
			sameEmail(input.sessionBinding.email, input.email);
		return sessionMatches
			? { kind: "adopt", writeOwner: true, name: input.vaultName }
			: { kind: "select", clear: true };
	}
	const hit = listed.find((v) => v.vaultId === input.vaultId);
	return hit
		? { kind: "adopt", writeOwner: true, name: hit.name || input.vaultName }
		: { kind: "select", clear: true };
}

/**
 * 仓库管理列表成功返回后的绑定核对。
 * vaults === null（列表加载失败）时绝不解绑。
 */
export function resolveVaultListBinding(
	vaultId: string,
	vaults: readonly Pick<VaultInfo, "vaultId">[] | null,
): { bound: boolean; stale: boolean } {
	if (!vaultId) return { bound: false, stale: false };
	if (vaults === null) return { bound: true, stale: false };
	const exists = vaults.some((v) => v.vaultId === vaultId);
	return { bound: exists, stale: !exists };
}

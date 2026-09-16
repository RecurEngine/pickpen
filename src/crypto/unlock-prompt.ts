// 未解锁时的主动弹窗文案与去重判定。
//
// 触发点只有一个：同步过程取到 Head 后，发现「仓库已加密、但本机没有可用的内容密钥」。
// 抽成不依赖 obsidian 的纯模块，便于直接单测判定规则。

export interface UnlockPromptCopy {
	title: string;
	description: string;
}

/** 对方把原本未加密的仓库转为加密：本机此前没有该仓库的密钥，属于首次启用 */
export const UNLOCK_COPY_ENABLED: UnlockPromptCopy = {
	title: "仓库已启用端到端加密",
	description:
		"该仓库已在其他设备启用端到端加密，请输入仓库密码解锁后继续同步。" +
		"密码只在本机校验、不会上传；一旦忘记密码，仓库内容将无法恢复。",
};

/** 本机原本能解开该仓库，对方改了密码：原有解锁状态已失效 */
export const UNLOCK_COPY_KEY_CHANGED: UnlockPromptCopy = {
	title: "仓库密码已在其他设备变更",
	description:
		"该仓库的密码已在其他设备修改，本机原有的解锁状态已失效。" +
		"请输入该仓库当前的密码后继续同步。密码只在本机校验、不会上传。",
};

/** 本机没有可用密钥（首次遇到加密仓库、本机记忆缺失，或已关闭「在本设备记住仓库密码」） */
export const UNLOCK_COPY_NEED_KEY: UnlockPromptCopy = {
	title: "仓库已加密，需要解锁",
	description:
		"该仓库已启用端到端加密，本机还没有可用的内容密钥。请输入仓库密码解锁后继续同步。" +
		"密码只在本机校验、不会上传；一旦忘记密码，仓库内容将无法恢复。",
};

/** 弹窗去重键：同一仓库的同一密钥版本只自动弹一次 */
export function unlockPromptKey(vaultId: string, keyVersion: string): string {
	return `${vaultId}:${keyVersion}`;
}

export interface AutoUnlockPromptInput {
	/** 刚刚换绑到另一个仓库：由绑定流程交互处理，这里不弹 */
	switched: boolean;
	/** 尝试本设备记忆之后仍未解锁 */
	locked: boolean;
	/** 同一仓库的密钥版本已在别处变更（只决定文案，不决定是否弹） */
	keyChanged: boolean;
	/** 早在本次变更之前，本机是否已把该仓库认作加密仓库（区分「刚启用加密」与「改了密码」） */
	wasEncrypted: boolean;
	vaultId: string;
	keyVersion: string;
	/** 已经自动弹过的键（"" = 从未弹过） */
	promptedKey: string;
}

/**
 * 判定是否要主动弹解锁窗。返回 null 表示不弹。
 *
 * 密钥版本参与去重键：对方第二次改密码时键会变，从而重新提示；
 * 若只用仓库 ID 做键，用户会从此永久静默。
 */
export function resolveAutoUnlockPrompt(
	input: AutoUnlockPromptInput,
): { key: string; copy: UnlockPromptCopy } | null {
	if (input.switched || !input.locked) return null;
	const key = unlockPromptKey(input.vaultId, input.keyVersion);
	if (key === input.promptedKey) return null; // 已经提示过：用户取消后不再每轮打扰
	return { key, copy: pickCopy(input.keyChanged, input.wasEncrypted) };
}

/**
 * 文案三分支：
 * - 密钥没变过 → 本机本来就没有可用密钥（首次遇到加密仓库、记忆缺失或已关闭「记住」）；
 * - 密钥变过、且本机原本已把该仓库认作加密仓库 → 对方改了密码；
 * - 密钥变过、但本机原本当它是明文仓库 → 对方刚把仓库转为加密。
 */
function pickCopy(keyChanged: boolean, wasEncrypted: boolean): UnlockPromptCopy {
	if (!keyChanged) return UNLOCK_COPY_NEED_KEY;
	return wasEncrypted ? UNLOCK_COPY_KEY_CHANGED : UNLOCK_COPY_ENABLED;
}

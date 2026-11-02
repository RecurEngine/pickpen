// 兑换码输入清洗：与服务端保持同一套展示约定，但不在客户端重复实现校验位算法。
// 服务端接受完整格式、16 位载荷、小写、空格与连字符；客户端只做输入体验上的归一化。

const PAYLOAD_LENGTH = 16;
const ALPHABET = new Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ");

/** 输入框占位符：展示真实码形，避免 UI 文案规则把大写码形改写。 */
export const REDEEM_CODE_PLACEHOLDER = "PP-XXXX-XXXX-XXXX-XXXX";

/** 输入过程中的清洗：转大写、去空白/连字符、I/L→1、O→0；不剥 PP，避免逐字输入时跳变。 */
export function sanitizeRedeemCodeInput(raw: string): string {
	return raw
		.toUpperCase()
		.replace(/[\s-]/g, "")
		.replace(/[IL]/g, "1")
		.replace(/O/g, "0");
}

/** 提交前规范化：长度大于 16 且以 PP 开头时剥离前缀；长度等于 16 时不动。 */
export function normalizeRedeemCodeInput(raw: string): string {
	let value = sanitizeRedeemCodeInput(raw);
	if (value.length > PAYLOAD_LENGTH && value.startsWith("PP")) {
		value = value.slice(2);
	}
	return value;
}

/** 是否为可能合法的 16 位载荷；校验位由服务端验证。 */
export function isRedeemCodeCandidate(payload: string): boolean {
	return payload.length === PAYLOAD_LENGTH && [...payload].every((ch) => ALPHABET.has(ch));
}

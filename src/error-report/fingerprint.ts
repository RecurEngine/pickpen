// 消息归一化与本地指纹。
// 本地指纹只用于本机去重/采样；服务端会用同一套字段语义重算 SHA-256 作为分组唯一口径。
// 归一化必须删掉数字/ID/路径等可变部分，否则同一 bug 会在不同设备上分裂成多组。

const LONG_HEX_RE = /\b[0-9a-f]{16,}\b/gi;
const NUMBER_RE = /\b\d+(?:\.\d+)?\b/g;
const SPACE_RE = /\s+/g;

/** 归一化后的消息，最多 256 个字符；空消息返回空串，由调用方决定占位值。 */
export function normalizeMessage(value: string): string {
	const normalized = value
		.replace(LONG_HEX_RE, "<hex>")
		.replace(NUMBER_RE, "<n>")
		.replace(SPACE_RE, " ")
		.trim();
	return Array.from(normalized).slice(0, 256).join("");
}

/**
 * 本地指纹：与服务端一样只用 phase / errorName / code / httpStatus / 归一化消息，
 * 不含版本、平台、堆栈、行号、设备与用户标识。
 */
export function clientFingerprint(
	phase: string,
	errorName: string,
	code: number,
	httpStatus: number,
	normalizedMessage: string,
	fnv1aHex: (input: string) => string,
): string {
	return fnv1aHex(
		["v1", phase, errorName, String(code), String(httpStatus), normalizedMessage || "<empty>"].join("|"),
	);
}

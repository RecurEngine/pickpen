// 本机脱敏：错误消息与调用栈在入队前先移除用户可识别信息。
// 服务端还会做第二道脱敏，这里的目标是「即使抓包也看不到明文」。
// 注意不要用 console 或 debugLog 记录原文，避免泄露到日志面板。

import type { SanitizeSecrets } from "./types";

const POSIX_PATH_RE = /(?:\/Users|\/home|\/private|\/var|\/tmp|\/root|\/sdcard|\/storage\/emulated\/0)(?:\/[^\s'"()[\]]+)+/g;
const WINDOWS_PATH_RE = /\b[A-Z]:\\[^\s'"()[\]]*/gi;
const URL_SIG_RE = /([?&](?:signature|sig|token|access_token|refresh_token|x-amz-signature|x-cos-security-token|x-amz-credential)=)[^&\s]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER_RE = /bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// 不使用 \b 包裹：JS 的 \b 只认 ASCII 单词字符，中文文件名前不会形成边界。
const FILE_RE = /[^\s/\\'"()<>]+\.(?:md|markdown|canvas|png|jpe?g|gif|webp|svg|pdf|json|css|js|ts|txt|csv|zip|mp3|mp4|mov|wav|docx?|xlsx?|pptx?)(?![A-Za-z0-9])/gi;

/** 去掉控制字符，保留换行/制表（栈需要换行）。 */
function stripControl(value: string): string {
	let out = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 9 || code === 10 || code === 13) {
			out += char;
			continue;
		}
		if (code < 32 || code === 127) continue;
		out += char;
	}
	return out;
}

/** 通用文本脱敏：路径、邮箱、令牌、签名参数、UUID。 */
export function sanitizeText(value: string, secrets: SanitizeSecrets): string {
	if (!value) return "";
	let out = stripControl(value);
	// 精确替换优先于正则：仓库名可能不含路径特征，绝对路径可能被拆成多段。
	if (secrets.vaultBasePath) out = out.split(secrets.vaultBasePath).join("<vault-path>");
	if (secrets.vaultName) out = out.split(secrets.vaultName).join("<vault>");
	return out
		.replace(POSIX_PATH_RE, "<path>")
		.replace(WINDOWS_PATH_RE, "<path>")
		.replace(URL_SIG_RE, "$1<redacted>")
		.replace(EMAIL_RE, "<email>")
		.replace(BEARER_RE, "Bearer <token>")
		.replace(JWT_RE, "<token>")
		.replace(UUID_RE, "<uuid>")
		.replace(LONG_TOKEN_RE, "<token>");
}

/**
 * 错误消息额外移除带扩展名的文件名。文件名本身可能就是笔记标题，
 * 属于用户内容；牺牲少量诊断信息换取隐私。
 */
export function sanitizeMessage(value: string, secrets: SanitizeSecrets): string {
	return sanitizeText(value, secrets).replace(FILE_RE, "<file>");
}

/** 按字节截断到 UTF-8 边界。 */
export function truncateUtf8(value: string, maxBytes: number): string {
	if (!value) return "";
	if (new TextEncoder().encode(value).length <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (new TextEncoder().encode(value.slice(0, mid)).length <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return value.slice(0, low);
}

/** 按字符（码点）截断，避免切坏代理对。 */
export function truncateChars(value: string, maxChars: number): string {
	const chars = Array.from(value);
	if (chars.length <= maxChars) return value;
	return chars.slice(0, maxChars).join("");
}

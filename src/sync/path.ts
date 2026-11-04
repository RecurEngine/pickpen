// 协议路径规范化（spec §6.1）：NFC 规范化、/ 分隔、无前导 / 的相对路径。
// 大小写属于路径语义，不做任何小写化。

export const MAX_PATH_LEN = 512;

const textEncoder = new TextEncoder();

/** 路径字节长度（UTF-8 编码后字节数；协议路径上限按字节计） */
export function pathByteLen(path: string): number {
	return textEncoder.encode(path).length;
}

/** 协议禁用字符：反斜杠与 NUL / CR / LF（等价于原先的字符类写法，改为显式判断以避免正则出现控制字符转义） */
function hasIllegalChar(path: string): boolean {
	for (const ch of path) {
		const code = ch.charCodeAt(0);
		if (ch === "\\" || code === 0x00 || code === 0x0a || code === 0x0d) return true;
	}
	return false;
}

/**
 * NFC 规范化 + 相对路径校验：禁绝对路径、反斜杠、控制字符、空 segment、. 与 ..。
 * 返回规范化后的路径；非法返回 null。
 */
export function nfcPath(path: string): string | null {
	if (
		path === "" ||
		pathByteLen(path) > MAX_PATH_LEN ||
		path.startsWith("/") ||
		hasIllegalChar(path)
	) {
		return null;
	}
	for (const seg of path.split("/")) {
		if (seg === "" || seg === "." || seg === "..") return null;
	}
	return path.normalize("NFC");
}

/**
 * 大小写冲突检测（spec §2.1/§16.5）：大小写不敏感平台上，NFC 后仅大小写不同的
 * 路径对（如 A.md 与 a.md）无法共存，必须报告冲突并阻塞相关文件同步。
 * 大小写敏感平台返回空数组。
 */
export function detectCaseConflicts(paths: string[], caseInsensitive: boolean): string[] {
	if (!caseInsensitive) return [];
	const byLower = new Map<string, string[]>();
	for (const p of paths) {
		const key = p.toLowerCase();
		const list = byLower.get(key);
		if (list) list.push(p);
		else byLower.set(key, [p]);
	}
	const conflicts: string[] = [];
	for (const list of byLower.values()) {
		if (list.length > 1) conflicts.push(...list);
	}
	return conflicts;
}

/** Windows 单段禁用字符（`\` 协议层已禁，这里防御性一并判断） */
const WINDOWS_ILLEGAL_CHARS = /[<>:"|?*\\]/;

/** Windows 保留设备名：段名第一个 `.` 之前的部分（大小写不敏感，带扩展名同样命中） */
const WINDOWS_RESERVED_NAMES = new Set([
	"CON",
	"PRN",
	"AUX",
	"NUL",
	"CONIN$",
	"CONOUT$",
	...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
	...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** 单个路径段能否在 Windows 上原样创建 */
function isWindowsSegmentLandable(segment: string): boolean {
	// NTFS 单段上限按 UTF-16 code unit 计
	if (segment === "" || segment.length > 255) return false;
	for (const ch of segment) {
		if (ch.charCodeAt(0) < 0x20 || WINDOWS_ILLEGAL_CHARS.test(ch)) return false;
	}
	// 段尾的点/空格会被 Win32 静默裁掉，实际落地名与远端路径不一致
	if (segment.endsWith(".") || segment.endsWith(" ")) return false;
	const stem = segment.split(".")[0].replace(/ +$/u, "").toUpperCase();
	return !WINDOWS_RESERVED_NAMES.has(stem);
}

/**
 * 本地可落地性（Windows 文件名规则）：协议路径合法 ≠ 当前系统能原样创建同名文件。
 * 远端下发的路径在 Windows 上可能因非法字符/保留名/段长而永远写不进去
 * （Win32 返回 ERROR_INVALID_NAME，Node/libuv 映射为 ENOENT），必须在计划阶段阻塞，
 * 不能等到写盘时抛错——那会中止整轮同步并让 pending 无法应用。
 *
 * 协议口径（nfcPath）保持不变：`"` 等在 macOS/Android/Linux 上仍是合法文件名。
 * POSIX 不再做额外校验（协议已覆盖 `/`、NUL 等）。
 */
export function isLocalPathLandable(path: string, isWindows: boolean): boolean {
	if (!isWindows) return true;
	for (const segment of path.split("/")) {
		if (!isWindowsSegmentLandable(segment)) return false;
	}
	return true;
}

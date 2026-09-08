// 协议路径规范化（spec §6.1）：NFC 规范化、/ 分隔、无前导 / 的相对路径。
// 大小写属于路径语义，不做任何小写化。

export const MAX_PATH_LEN = 512;

const textEncoder = new TextEncoder();

/** 路径字节长度（UTF-8 编码后字节数；协议路径上限按字节计） */
export function pathByteLen(path: string): number {
	return textEncoder.encode(path).length;
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
		/[\\\x00\r\n]/.test(path)
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

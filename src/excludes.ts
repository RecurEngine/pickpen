// 排除清单基础件：默认清单、路径规范化与隐藏判定、通配匹配、动态套餐单文件上限过滤。
// 完整的同步范围判定（类型白名单 / 排除文件夹 / 配置目录分类）见 sync/selective.ts，
// 本文件只提供它复用的原语。

// 默认排除清单（FR-4，不可同步；无 UI，用户可见的排除只有「需要排除的文件夹」）。
// 配置目录不在此列：任何以 . 开头的路径段都由 isHidden 拦下（含用户自定义的配置目录名）。
export const DEFAULT_EXCLUDES = [".trash/", "*.tmp", "~$*", ".DS_Store", "Thumbs.db"];

// normalize 路径统一为 / 分隔、无前导 /
// 注意：不做小写化——大小写属于路径语义（spec §2.1），身份一律 NFC 原始大小写路径
export function normalize(path: string): string {
	let p = path.replace(/\\/g, "/");
	while (p.startsWith("/")) {
		p = p.slice(1);
	}
	return p;
}

// isHidden 隐藏文件：任一路径段以 . 开头（.obsidian/.trash 亦被此规则覆盖）
export function isHidden(path: string): boolean {
	return path.split("/").some((seg) => seg.startsWith("."));
}

// matchPattern 排除模式匹配：无 * 为目录前缀；前缀 * 为后缀匹配；后缀 * 为 basename 前缀匹配
export function matchPattern(path: string, pattern: string): boolean {
	const basename = path.split("/").pop() ?? path;
	if (pattern.startsWith("*")) {
		return path.endsWith(pattern.slice(1));
	}
	if (pattern.endsWith("*")) {
		return basename.startsWith(pattern.slice(0, -1));
	}
	return path === pattern || path.startsWith(pattern);
}

export function isTooBig(size: number, maxFileSizeBytes: number): boolean {
	return size > maxFileSizeBytes;
}

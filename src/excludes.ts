// 排除清单 + 路径规范化 + 动态套餐单文件上限过滤

// 默认排除清单（FR-4，不可同步）；设置面板可追加 extraExcludes
const DEFAULT_EXCLUDES = [".obsidian/", ".trash/", "*.tmp", "~$*", ".DS_Store", "Thumbs.db"];

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
function isHidden(path: string): boolean {
	return path.split("/").some((seg) => seg.startsWith("."));
}

// matchPattern 排除模式匹配：无 * 为目录前缀；前缀 * 为后缀匹配；后缀 * 为 basename 前缀匹配
function matchPattern(path: string, pattern: string): boolean {
	const basename = path.split("/").pop() ?? path;
	if (pattern.startsWith("*")) {
		return path.endsWith(pattern.slice(1));
	}
	if (pattern.endsWith("*")) {
		return basename.startsWith(pattern.slice(0, -1));
	}
	return path === pattern || path.startsWith(pattern);
}

// isExcluded 排除过滤（FR-4 排除清单生效）
export function isExcluded(path: string, extraExcludes: string[]): boolean {
	const p = normalize(path);
	if (isHidden(p)) {
		return true;
	}
	for (const pattern of [...DEFAULT_EXCLUDES, ...extraExcludes]) {
		if (pattern && matchPattern(p, pattern)) {
			return true;
		}
	}
	return false;
}

export function isTooBig(size: number, maxFileSizeBytes: number): boolean {
	return size > maxFileSizeBytes;
}

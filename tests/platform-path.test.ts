// 平台可落地性：协议路径合法 ≠ 当前系统能创建同名文件。
// 线上背景：Windows 端同步 macOS/Android 创建的 `字课05"腠理".md` 时，
// writeBinary 必然抛 ENOENT（Win32 ERROR_INVALID_NAME），旧代码会让整轮同步永久卡死。
import { describe, expect, it } from "vitest";
import { isLocalPathLandable } from "../src/sync/path";

const WINDOWS_INVALID = [
	'ima/字课/字课05"腠理".md',
	"a<b.md",
	"a>b.md",
	"a:b.md",
	"a|b.md",
	"a?b.md",
	"a*b.md",
	"a\u0001b.md",
	"a\u001fb.md",
	"a\\b.md",
	"dir./x.md",
	"dir /x.md",
	"a.md.",
	"a.md ",
	"CON",
	"con.md",
	"nul",
	"PRN.txt",
	"AUX",
	"COM1",
	"com9.md",
	"LPT1.tar.gz",
	"dir/COM1/x.md",
	"CONIN$",
	"CONOUT$",
	`${"a".repeat(256)}.md`,
	`${"😀".repeat(127)}.md`, // UTF-16 长度 254 + ".md" = 257 > 255
];

describe("isLocalPathLandable", () => {
	it("Windows：非法字符、保留名、段尾点/空格、超长段均不可落地", () => {
		for (const path of WINDOWS_INVALID) {
			expect(isLocalPathLandable(path, true), `isLocalPathLandable(${JSON.stringify(path)}, win)`).toBe(
				false,
			);
		}
	});

	it("Windows：合法名称可落地（全角引号、普通空格、多级目录）", () => {
		for (const path of [
			"字课05“腠理”.md",
			"a b.md",
			"a.b.c",
			"dir/正常名称.md",
			"CONSOLE.md",
			"COM10.md",
			"LPT0.md",
			`${"a".repeat(251)}.md`,
			`${"😀".repeat(126)}.md`, // UTF-16 长度 252 + ".md" = 255
		]) {
			expect(isLocalPathLandable(path, true), `isLocalPathLandable(${JSON.stringify(path)}, win)`).toBe(
				true,
			);
		}
	});

	it("POSIX：不做额外限制（双引号等仍可落地）", () => {
		for (const path of WINDOWS_INVALID) {
			expect(isLocalPathLandable(path, false), `isLocalPathLandable(${JSON.stringify(path)}, posix)`).toBe(
				true,
			);
		}
	});

	it("防御：空路径/空段在 Windows 上不可落地", () => {
		expect(isLocalPathLandable("", true)).toBe(false);
		expect(isLocalPathLandable("a//b", true)).toBe(false);
	});
});

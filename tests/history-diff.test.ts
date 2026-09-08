// diffTexts 纯函数测试：行级 diff + 行内字符高亮（jsdiff，node 环境可直接测）。
import { describe, expect, it } from "vitest";

import { diffTexts } from "../src/history-diff";

describe("diffTexts", () => {
	it("完全相同 → 全部 same，无 changes", () => {
		expect(diffTexts("a\nb", "a\nb")).toEqual([
			{ type: "same", text: "a" },
			{ type: "same", text: "b" },
		]);
	});

	it("空文本 vs 两行 → 全部 add", () => {
		const lines = diffTexts("", "a\nb");
		expect(lines.map((l) => l.type)).toEqual(["add", "add"]);
		expect(lines.map((l) => l.text)).toEqual(["a", "b"]);
	});

	it("两行 vs 空文本 → 全部 del", () => {
		const lines = diffTexts("a\nb", "");
		expect(lines.map((l) => l.type)).toEqual(["del", "del"]);
		expect(lines.map((l) => l.text)).toEqual(["a", "b"]);
	});

	it("空文本 vs 空文本 → 空数组", () => {
		expect(diffTexts("", "")).toEqual([]);
	});

	it("修改一行 → 相邻 del + add，行内高亮段", () => {
		const lines = diffTexts("a\nb", "a\nc");
		expect(lines.map((l) => l.type)).toEqual(["same", "del", "add"]);
		const del = lines[1];
		const add = lines[2];
		// del 行只含 removed 段（不含 added 段），add 行只含 added 段
		expect(del.changes?.some((c) => c.removed)).toBe(true);
		expect(del.changes?.some((c) => c.added)).toBe(false);
		expect(add.changes?.some((c) => c.added)).toBe(true);
		expect(add.changes?.some((c) => c.removed)).toBe(false);
	});

	it("行内高亮：hello world → hello obsidian", () => {
		const lines = diffTexts("hello world", "hello obsidian");
		const add = lines.find((l) => l.type === "add");
		const del = lines.find((l) => l.type === "del");
		expect(del?.changes).toEqual([{ value: "hello " }, { removed: true, value: "world" }]);
		expect(add?.changes).toEqual([{ value: "hello " }, { added: true, value: "obsidian" }]);
	});

	it("CRLF 文本 → 行文本无 \\r 残留", () => {
		const lines = diffTexts("a\r\nb\r\nc", "a\r\nx\r\nc");
		for (const l of lines) {
			expect(l.text.includes("\r")).toBe(false);
		}
		expect(lines.map((l) => l.text)).toEqual(["a", "b", "x", "c"]);
	});

	it("行数不等改动 → 不崩（不配对行跳过行内高亮）", () => {
		const lines = diffTexts("a\nb\nc", "x");
		const addCount = lines.filter((l) => l.type === "add").length;
		const delCount = lines.filter((l) => l.type === "del").length;
		expect(addCount + delCount).toBeGreaterThan(0);
		// 至少一行无 changes（配对不足跳过行内高亮）
		expect(lines.some((l) => (l.type === "add" || l.type === "del") && l.changes === undefined)).toBe(true);
	});

	it("删除空行 → del 行 text 为空（渲染 ± 占位）", () => {
		const lines = diffTexts("a\n\nb", "a\nb");
		expect(lines.some((l) => l.type === "del" && l.text === "")).toBe(true);
	});

	it("末尾有/无换行 → 行数与内容正确", () => {
		const lines = diffTexts("a", "a\n");
		// 差异仅为末尾换行：要么全 same，要么追加一个空 add 行
		expect(lines.every((l) => l.type === "same" || (l.type === "add" && l.text === ""))).toBe(true);
	});
});

// 三方合并表驱动测试（spec §8.2 扩展）。
// 语义基准是 git merge-file（xdl_merge 的 diff3 变体）：下列边界用例逐条与
// `git merge-file -p --diff3` 对拍过，fixture 亦由它生成（见 merge3-cases.json）。
// 与 BSD diff3 的已知分歧只有一类：双方改成完全相同的内容，BSD 报冲突而 git 判干净——本实现取 git。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { merge3Text } from "../src/sync/merge3";

interface FixtureCase {
	name: string;
	base: string;
	ours: string;
	theirs: string;
	clean: boolean;
	expected?: string;
}

const fixture = JSON.parse(
	readFileSync(join(__dirname, "fixtures/merge3-cases.json"), "utf-8"),
) as { cases: FixtureCase[] };

/** 与 merge3 内部同一套行切分（每行含自身行尾换行）：性质断言必须按同一口径分行 */
const toLines = (text: string): string[] => (text === "" ? [] : (text.match(/[^\n]*\n|[^\n]+/g) ?? []));

const counts = (lines: string[]): Map<string, number> => {
	const m = new Map<string, number>();
	for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
	return m;
};

describe("merge3Text 边界语义（与 git merge-file 对齐）", () => {
	const cases: Array<[string, string, string, string, string | null]> = [
		// [名称, base, ours, theirs, 期望文本（null = 期望冲突）]
		["全空", "", "", "", ""],
		["base 空、我方新增", "", "a\n", "", "a\n"],
		["无尾换行", "a", "a", "a", "a"],
		["我方去掉尾换行", "a\n", "a", "a\n", "a"],
		["双方改成完全相同", "a\n", "a\nX\n", "a\nX\n", "a\nX\n"],
		["两端各增一处、中间隔一行", "1\n2\n3\n4\n5\n", "1\n2-改\n3\n4\n5\n", "1\n2\n3\n4-改\n5\n", "1\n2-改\n3\n4-改\n5\n"],
		["一方多行追加、另一方改别处", "1\n2\n3\n", "1\n2\n3\n4\n5\n", "1\n2-改\n3\n", "1\n2-改\n3\n4\n5\n"],
		["中间两处插入相隔", "a\nb\nc\n", "a\nX\nb\nc\n", "a\nb\nY\nc\n", "a\nX\nb\nY\nc\n"],
		["CRLF 两端相同新增", "a\r\nb\r\n", "a\r\nb\r\nX\r\n", "a\r\nb\r\nX\r\n", "a\r\nb\r\nX\r\n"],
		// —— 以下为冲突（diff3 要求两处改动之间有未变行才算互相独立）——
		["相邻行各改一行", "1\n2\n3\n4\n5\n", "1\n2-改\n3\n4\n5\n", "1\n2\n3-改\n4\n5\n", null],
		["同一行改法不同", "1\n2\n3\n", "1\n2-本地\n3\n", "1\n2-远端\n3\n", null],
		["一方删、一方改同一行", "1\n2\n3\n", "1\n2-本地\n3\n", "1\n3\n", null],
		["末尾各追加一行", "a\nb\n", "a\nb\nX\n", "a\nb\nY\n", null],
		["中间同一位置各插入一行", "a\nb\nc\n", "a\nb\nX\nc\n", "a\nb\nY\nc\n", null],
		["CRLF 两端各增一行", "a\r\nb\r\n", "a\r\nb\r\nX\r\n", "a\r\nb\r\nY\r\n", null],
	];

	for (const [name, base, ours, theirs, expected] of cases) {
		it(name, () => {
			const r = merge3Text(base, ours, theirs);
			if (expected === null) {
				expect(r.clean).toBe(false);
				expect(r.conflictCount).toBeGreaterThan(0);
			} else {
				expect(r.clean).toBe(true);
				expect(r.text).toBe(expected);
			}
		});
	}
});

describe("merge3Text 性质", () => {
	it("任一侧与 base 相同 → 直接取另一侧（快路，不产生冲突）", () => {
		const base = "a\nb\nc\n";
		expect(merge3Text(base, base, "a\nX\nc\n")).toEqual({ clean: true, text: "a\nX\nc\n", conflictCount: 0 });
		expect(merge3Text(base, "a\nX\nc\n", base)).toEqual({ clean: true, text: "a\nX\nc\n", conflictCount: 0 });
	});

	it("双方内容相同时不产生冲突", () => {
		expect(merge3Text("a\n", "z\n", "z\n")).toEqual({ clean: true, text: "z\n", conflictCount: 0 });
	});

	it("对调 ours/theirs 的判定与结果一致（裁决与参数顺序无关）", () => {
		const cases: Array<[string, string, string]> = [
			["1\n2\n3\n4\n5\n", "1\n2-改\n3\n4\n5\n", "1\n2\n3\n4-改\n5\n"],
			["1\n2\n3\n", "1\n2-本地\n3\n", "1\n2-远端\n3\n"],
			["a\nb\n", "a\nb\nX\n", "a\nb\nY\n"],
			["", "a\n", "b\n"],
		];
		for (const [base, ours, theirs] of cases) {
			const ab = merge3Text(base, ours, theirs);
			const ba = merge3Text(base, theirs, ours);
			expect(ba.clean).toBe(ab.clean);
			if (ab.clean) expect(ba.text).toBe(ab.text);
		}
	});

	it("干净合并不丢任何一方新增的行（对照 Obsidian patch 重放的静默丢弃）", () => {
		// 确定性伪随机（mulberry32）：与 fixture 生成脚本同种子约定，保证可复现
		let seed = 20260924;
		const rnd = (): number => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const ri = (n: number): number => Math.floor(rnd() * n);
		let cleanCount = 0;
		for (let round = 0; round < 400; round++) {
			const eol = rnd() < 0.2 ? "\r\n" : "\n";
			const baseText = Array.from({ length: 2 + ri(14) }, (_, i) => `L${i}${eol}`).join("");
			const mutate = (): string => {
				const lines = toLines(baseText);
				for (let k = 0; k < 1 + ri(3); k++) {
					const op = ri(3);
					const at = ri(lines.length + 1);
					if (op === 0) lines.splice(at, 0, `N${ri(1000)}${eol}`);
					else if (op === 1 && at < lines.length) lines.splice(at, 1);
					else if (at < lines.length) lines[at] = `C${ri(1000)}${eol}`;
				}
				return lines.join("");
			};
			// 新增量按「最终内容相对 base 的行多重集差」计算：同轮后续操作可能把先前插入的行再删掉/改掉，
			// 逐操作记录会把已不存在的行也算成新增
			const baseCount = counts(toLines(baseText));
			const beyond = (text: string): Map<string, number> => {
				const c = counts(toLines(text));
				for (const [v, n] of baseCount) c.set(v, (c.get(v) ?? 0) - n);
				return c;
			};
			const ourText = mutate();
			const theirText = mutate();
			const r = merge3Text(baseText, ourText, theirText);
			if (!r.clean) continue;
			cleanCount++;
			const merged = r.text!;
			const mergedCount = counts(toLines(merged));
			// 双方各自净新增的每一行都必须保留：结果取的是 ours / theirs 的文本，不是丢弃式叠加
			const theirBeyond = beyond(theirText);
			for (const [v, n] of beyond(ourText)) {
				const required = Math.max(n, theirBeyond.get(v) ?? 0);
				if (required <= 0) continue;
				expect(mergedCount.get(v) ?? 0, `新增行被丢弃：${JSON.stringify(v)}`).toBeGreaterThanOrEqual(required);
			}
			// 行尾不被归一化：CRLF 的样本里不得出现任何「\n 前面不是 \r」的行尾
			if (eol === "\r\n") expect(/(?<!\r)\n/.test(merged)).toBe(false);
		}
		expect(cleanCount).toBeGreaterThan(50); // 样本里确实有足够多的干净合并被验证过
	});
});

describe("merge3Text fixture 对拍（git merge-file 生成）", () => {
	it(`fixture 共 ${fixture.cases.length} 例，判定与文本全部一致`, () => {
		let clean = 0;
		for (const c of fixture.cases) {
			const r = merge3Text(c.base, c.ours, c.theirs);
			expect(r.clean, `${c.name} clean 判定`).toBe(c.clean);
			if (c.clean) {
				expect(r.text, `${c.name} 合并文本`).toBe(c.expected);
				clean++;
			} else {
				expect(r.conflictCount, `${c.name} 冲突计数`).toBeGreaterThan(0);
			}
		}
		expect(clean).toBeGreaterThan(0);
		expect(clean).toBeLessThan(fixture.cases.length); // 冲突与干净两类都被覆盖
	});
});

// 冲突内容级合并（merge-pass）测试：plan 改写结果、资格判定、降级路径与改写原子性。
// 用例经真实 planner 产出冲突副本，保证输入形状与线上一致。
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/sync/content-hash";
import { resolveConflictsByMerge, type MergeDeps } from "../src/sync/merge-pass";
import { plan } from "../src/sync/planner";
import type { Entry, Snapshot, SyncPlan } from "../src/sync/types";

const enc = new TextEncoder();
const hashOf = (text: string): Promise<string> => sha256Hex(enc.encode(text));

interface Scenario {
	plan: SyncPlan;
	base: Snapshot | null;
	remote: Snapshot;
	/** 三份内容（明文），供 deps 回放 */
	texts: { base: string; ours: string; theirs: string };
	/** 冲突副本路径 */
	copyPath: string;
}

/** 用真实 planner 造出「双方改成不同内容」的冲突计划 */
async function scenario(args: {
	baseText: string;
	oursText: string;
	theirsText: string;
	path?: string;
	hasBase?: boolean;
}): Promise<Scenario> {
	const path = args.path ?? "x.md";
	const [hBase, hOurs, hTheirs] = await Promise.all([
		hashOf(args.baseText),
		hashOf(args.oursText),
		hashOf(args.theirsText),
	]);
	const entry = (hash: string, text: string): Entry => ({
		state: "active",
		content_hash: hash,
		size: String(enc.encode(text).byteLength),
		kind: 1,
		file_id: "11111111-1111-4111-8111-111111111111",
	});
	const snap = (e: Record<string, Entry>): Snapshot => ({
		schema_version: 2,
		device_id: "dev-001",
		vault_id: "42",
		base_revision: "1",
		base_root_hash: "root1",
		entries: e,
	});
	const base = args.hasBase === false ? null : snap({ [path]: entry(hBase, args.baseText) });
	const local = snap({ [path]: entry(hOurs, args.oursText) });
	const remote = snap({ [path]: entry(hTheirs, args.theirsText) });
	const p = plan({ base, local, remote, deviceId: "dev-001", now: new Date("2026-09-24T12:00:00Z") });
	expect(p.conflict_copies).toHaveLength(1); // 前提：确实产出了冲突副本
	return {
		plan: p,
		base,
		remote,
		texts: { base: args.baseText, ours: args.oursText, theirs: args.theirsText },
		copyPath: p.conflict_copies[0].path,
	};
}

function deps(s: Scenario, overrides: Partial<MergeDeps> = {}): MergeDeps {
	return {
		readLocal: async () => enc.encode(s.texts.ours),
		readBase: async () => enc.encode(s.texts.base),
		readRemote: async () => enc.encode(s.texts.theirs),
		seal: async (content) => ({ hash: await sha256Hex(content), bytes: content }),
		stage: async () => undefined,
		...overrides,
	};
}

const run = (s: Scenario, d: MergeDeps, isConfigPath: (p: string) => boolean = () => false) =>
	resolveConflictsByMerge({ plan: s.plan, base: s.base, remote: s.remote, isConfigPath, deps: d });

/**
 * plan 自洽性：每个 put 都能在 target_entries 找到同 hash/size/file_id 的 active 条目。
 * 这是提交能被服务端重算校验通过的前提，合并改写 plan 后尤其要守住。
 */
function expectCoherentPlan(p: SyncPlan): void {
	for (const mut of p.puts) {
		const e = p.target_entries[mut.path];
		expect(e, `put ${mut.path} 在 target_entries 中缺失`).toBeDefined();
		expect(e.state, `put ${mut.path} 的目标条目不是 active`).toBe("active");
		expect(e.content_hash).toBe(mut.content_hash);
		expect(String(e.size)).toBe(mut.size);
		expect(e.file_id).toBe(mut.file_id);
	}
	for (const cc of p.conflict_copies) {
		expect(p.target_entries[cc.path]?.state, `冲突副本 ${cc.path} 未进入目标树`).toBe("active");
	}
	// write 动作的目标内容必须与 target_entries 一致
	for (const a of p.apply_actions) {
		if (a.kind !== "write") continue;
		expect(p.target_entries[a.path]?.content_hash, `write ${a.path} 与目标树不一致`).toBe(a.content_hash);
	}
}

describe("干净合并消解冲突副本", () => {
	it("双方改不同段落 → 摘除副本，原路径落合并结果并提交", async () => {
		const s = await scenario({
			baseText: "1\n2\n3\n4\n5\n",
			oursText: "1\n2-本地\n3\n4\n5\n",
			theirsText: "1\n2\n3\n4-远端\n5\n",
		});
		const staged: Array<{ hash: string; bytes: Uint8Array }> = [];
		const r = await run(s, deps(s, { stage: async (hash, bytes) => void staged.push({ hash, bytes }) }));
		expectCoherentPlan(s.plan);

		expect(s.plan.conflict_copies).toEqual([]);
		expect(r.mergedPaths.has("x.md")).toBe(true);
		// 原路径的写动作改为落合并结果
		const write = s.plan.apply_actions.find((a) => a.kind === "write" && a.path === "x.md")!;
		const merged = "1\n2-本地\n3\n4-远端\n5\n";
		const mergedHash = await hashOf(merged);
		expect(write.content_hash).toBe(mergedHash);
		expect(write.size).toBe(String(enc.encode(merged).byteLength));
		// 上传与目标条目都是合并结果，file_id 沿用原路径身份（非副本新 UUID）
		expect(s.plan.puts).toEqual([
			{
				path: "x.md",
				content_hash: mergedHash,
				size: String(enc.encode(merged).byteLength),
				file_id: "11111111-1111-4111-8111-111111111111",
				kind: 1,
			},
		]);
		expect(s.plan.target_entries["x.md"].content_hash).toBe(mergedHash);
		expect(s.plan.target_entries[s.copyPath]).toBeUndefined();
		// 合并产物落临时区且登记为已就绪
		expect(staged).toHaveLength(1);
		expect(staged[0].hash).toBe(mergedHash);
		expect(new TextDecoder().decode(staged[0].bytes)).toBe(merged);
		expect(r.stagedHashes.has(mergedHash)).toBe(true);
	});

	it("合并结果与远端一致 → 摘除副本，不产生提交（本地改动已被远端涵盖）", async () => {
		// ours 的改动是 theirs 改动的子集：base → theirs 已包含 ours 的插入
		const s = await scenario({
			baseText: "1\n2\n3\n",
			oursText: "1\nX\n2\n3\n",
			theirsText: "1\nX\n2\n3\n4\n",
		});
		// planner 会把「内容相同」判成无冲突，这里构造 ours 与 theirs 不同但合并结果等于 theirs 的情形
		expect(s.plan.conflict_copies).toHaveLength(1);
		const r = await run(s, deps(s));
		expectCoherentPlan(s.plan);
		const theirsHash = await hashOf(s.texts.theirs);
		expect(s.plan.conflict_copies).toEqual([]);
		expect(r.mergedPaths.has("x.md")).toBe(true);
		// 保留原有的「写远端内容」动作与目标条目；不追加 put
		const write = s.plan.apply_actions.find((a) => a.kind === "write" && a.path === "x.md")!;
		expect(write.content_hash).toBe(theirsHash);
		expect(s.plan.puts.filter((p) => p.path === "x.md")).toEqual([]);
		expect(s.plan.target_entries["x.md"].content_hash).toBe(theirsHash);
		expect(r.stagedHashes.size).toBe(0);
	});
});

describe("不满足合并条件时原样保留冲突副本", () => {
	const cases: Array<[string, Parameters<typeof scenario>[0], (s: Scenario) => Partial<MergeDeps> | null, (p: string) => boolean]> = [
		["非 .md（按扩展名跳过）", { baseText: "a\n", oursText: "b\n", theirsText: "c\n", path: "x.canvas" }, () => null, () => false],
		["配置文件（远端胜规则）", { baseText: "a\n", oursText: "b\n", theirsText: "c\n", path: ".obsidian/app.json" }, () => null, (p) => p.startsWith(".obsidian/")],
		["无 Base（首次绑定）", { baseText: "a\n", oursText: "b\n", theirsText: "c\n", hasBase: false }, () => null, () => false],
		["base 取回失败（超保留期）", { baseText: "1\n2\n3\n", oursText: "1\nX\n2\n3\n", theirsText: "1\nY\n2\n3\n" }, () => ({ readBase: async () => { throw new Error("12021 不在存活期"); } }), () => false],
		["内容含 NUL 字节（二进制伪装）", { baseText: "1\n2\n3\n", oursText: "1\nX\n2\n3\n", theirsText: "1\nY\n2\n3\n" }, () => ({ readLocal: async () => enc.encode("1\n\u0000X\n2\n3\n") }), () => false],
		["超过大小上限", { baseText: "1\n2\n3\n", oursText: "1\nX\n2\n3\n", theirsText: "1\nY\n2\n3\n" }, () => null, () => false],
	];

	for (const [name, sc, ov, isCfg] of cases) {
		it(name, async () => {
			const s = await scenario(sc);
			const before = JSON.parse(JSON.stringify(s.plan));
			const d = deps(s, (ov(s) ?? {}) as Partial<MergeDeps>);
			await resolveConflictsByMerge({
				plan: s.plan,
				base: s.base,
				remote: s.remote,
				isConfigPath: isCfg,
				deps: d,
				maxBytes: name === "超过大小上限" ? 4 : undefined,
			});
			expect(s.plan.conflict_copies).toHaveLength(1);
			// 计划完全未被改写
			expect(JSON.parse(JSON.stringify(s.plan))).toEqual(before);
		});
	}

	it("存在冲突区 → 保留副本（不产出半成品）", async () => {
		const s = await scenario({
			baseText: "1\n2\n3\n",
			oursText: "1\n本地\n3\n",
			theirsText: "1\n远端\n3\n",
		});
		const before = JSON.parse(JSON.stringify(s.plan));
		const r = await run(s, deps(s));
		expect(r.mergedPaths.size).toBe(0);
		expect(s.plan.conflict_copies).toHaveLength(1);
		expect(JSON.parse(JSON.stringify(s.plan))).toEqual(before);
	});

	it("落临时区失败 → 计划不被部分改写（原子性）", async () => {
		const s = await scenario({
			baseText: "1\n2\n3\n4\n5\n",
			oursText: "1\n2-本地\n3\n4\n5\n",
			theirsText: "1\n2\n3\n4-远端\n5\n",
		});
		const before = JSON.parse(JSON.stringify(s.plan));
		const r = await run(s, deps(s, { stage: async () => { throw new Error("磁盘写入失败"); } }));
		expect(r.mergedPaths.size).toBe(0);
		expect(r.stagedHashes.size).toBe(0);
		expect(s.plan.conflict_copies).toHaveLength(1);
		// 关键：写动作 / puts / target_entries 都不得残留半改写
		expect(JSON.parse(JSON.stringify(s.plan))).toEqual(before);
	});

	it("file_id 被其他 active 路径占用（历史脏数据）→ 不合并，避免就地提交触发 12023", async () => {
		const s = await scenario({
			baseText: "1\n2\n3\n4\n5\n",
			oursText: "1\n2-本地\n3\n4\n5\n",
			theirsText: "1\n2\n3\n4-远端\n5\n",
		});
		// 远端另一条路径复用了同一 file_id：合并会沿用该身份就地提交，服务端必拒
		s.remote.entries["other.md"] = {
			state: "active",
			content_hash: "a".repeat(64),
			size: "3",
			kind: 1,
			file_id: "11111111-1111-4111-8111-111111111111",
		};
		const before = JSON.parse(JSON.stringify(s.plan));
		const r = await run(s, deps(s));
		expect(r.mergedPaths.size).toBe(0);
		expect(s.plan.conflict_copies).toHaveLength(1);
		expect(JSON.parse(JSON.stringify(s.plan))).toEqual(before);
	});

	it("加密仓库下上传的是密文、size 仍是明文长度（与扫描口径一致）", async () => {
		const s = await scenario({
			baseText: "1\n2\n3\n4\n5\n",
			oursText: "1\n2-本地\n3\n4\n5\n",
			theirsText: "1\n2\n3\n4-远端\n5\n",
		});
		const merged = "1\n2-本地\n3\n4-远端\n5\n";
		// 模拟加密仓库：hash = 密文哈希，size 仍取明文长度
		const pseudoSeal = async (content: Uint8Array) => {
			const ciphered = enc.encode(`SEALED:${new TextDecoder().decode(content)}`);
			return { hash: await sha256Hex(ciphered), bytes: ciphered };
		};
		await run(s, deps(s, { seal: pseudoSeal }));
		expectCoherentPlan(s.plan);
		const write = s.plan.apply_actions.find((a) => a.kind === "write" && a.path === "x.md")!;
		expect(write.size).toBe(String(enc.encode(merged).byteLength)); // 明文长度，不是密文长度
		expect(write.content_hash).toBe(await sha256Hex(enc.encode(`SEALED:${merged}`)));
		expect(s.plan.puts[0].size).toBe(write.size);
	});
});

describe("多副本混合场景", () => {
	it("可合并与不可合并并存时，只消解可合并的那个", async () => {
		const [hA, hB, hC, hD, hE, hF] = await Promise.all([
			hashOf("1\n2\n3\n4\n5\n"),
			hashOf("1\n2-本地\n3\n4\n5\n"),
			hashOf("1\n2\n3\n4-远端\n5\n"),
			hashOf("a\nb\nc\n"),
			hashOf("a\n本地\nc\n"),
			hashOf("a\n远端\nc\n"),
		]);
		// 两个文件各有独立身份：同一 file_id 出现在多条 active 路径会被身份守卫拦下
		const fid = (n: string): string => `11111111-1111-4111-8111-11111111111${n}`;
		const e = (hash: string, size: string, id: string): Entry => ({ state: "active", content_hash: hash, size, kind: 1, file_id: fid(id) });
		const snap = (entries: Record<string, Entry>): Snapshot => ({
			schema_version: 2,
			device_id: "dev-001",
			vault_id: "42",
			base_revision: "1",
			base_root_hash: "root1",
			entries,
		});
		const base = snap({ "ok.md": e(hA, "10", "1"), "bad.md": e(hD, "6", "2") });
		const local = snap({ "ok.md": e(hB, "14", "1"), "bad.md": e(hE, "10", "2") });
		const remote = snap({ "ok.md": e(hC, "14", "1"), "bad.md": e(hF, "10", "2") });
		const p = plan({ base, local, remote, deviceId: "dev-001", now: new Date("2026-09-24T12:00:00Z") });
		expect(p.conflict_copies).toHaveLength(2);

		const r = await resolveConflictsByMerge({
			plan: p,
			base,
			remote,
			isConfigPath: () => false,
			deps: {
				readLocal: async (path) => enc.encode(path === "ok.md" ? "1\n2-本地\n3\n4\n5\n" : "a\n本地\nc\n"),
				readBase: async (hash) => enc.encode(hash === hA ? "1\n2\n3\n4\n5\n" : "a\nb\nc\n"),
				readRemote: async (hash) => enc.encode(hash === hC ? "1\n2\n3\n4-远端\n5\n" : "a\n远端\nc\n"),
				seal: async (content) => ({ hash: await sha256Hex(content), bytes: content }),
				stage: async () => undefined,
			},
		});
		expect([...r.mergedPaths]).toEqual(["ok.md"]);
		expect(p.conflict_copies).toHaveLength(1);
		expect(p.conflict_copies[0].source_path).toBe("bad.md");
		// bad.md 仍按原冲突副本语义：远端占原路径、本地内容落副本
		expect(p.target_entries["bad.md"].content_hash).toBe(hF);
	});
});

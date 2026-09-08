// 三方对账 Planner 表驱动测试（spec §8.2 裁决矩阵 12 行 + §8.4 Bootstrap 6 行）。
// planner 输入不含 mtime → 设备时钟差异不影响冲突结果（§16.3）。
import { describe, expect, it } from "vitest";
import { entriesEqual, nextConflictCopyName, plan } from "../src/sync/planner";
import type { Entry, Snapshot } from "../src/sync/types";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

const active = (hash: string, size = "10"): Entry => ({
	state: "active",
	content_hash: hash,
	size,
});
const deleted: Entry = { state: "deleted" };

function snap(entries: Record<string, Entry>): Snapshot {
	return {
		schema_version: 2,
		device_id: "dev-001",
		vault_id: "42",
		base_revision: "1",
		base_root_hash: "root1",
		entries,
	};
}

function runPlan(base: Snapshot | null, local: Snapshot, remote: Snapshot) {
	const p = plan({ base, local, remote, deviceId: "dev-001", now: new Date("2026-08-28T12:00:00Z") });
	return p;
}

describe("§8.2 裁决矩阵", () => {
	it("未变/未变 → 无操作", () => {
		const b = snap({ "x.md": active(A) });
		const p = runPlan(b, snap({ "x.md": active(A) }), snap({ "x.md": active(A) }));
		expect(p.puts).toEqual([]);
		expect(p.deletes).toEqual([]);
		expect(p.apply_actions).toEqual([]);
	});

	it("Local 变/Remote 未变（修改）→ 接受 Local 提交远端", () => {
		const b = snap({ "x.md": active(A) });
		const p = runPlan(b, snap({ "x.md": active(B) }), snap({ "x.md": active(A) }));
		expect(p.puts).toEqual([expect.objectContaining({ path: "x.md", content_hash: B, size: "10", kind: 1 })]);
		expect(p.apply_actions).toEqual([]);
	});

	it("Local 变/Remote 未变（删除）→ 删除远端", () => {
		const b = snap({ "x.md": active(A) });
		const p = runPlan(b, snap({ "x.md": deleted }), snap({ "x.md": active(A) }));
		expect(p.deletes).toEqual(["x.md"]);
		expect(p.target_entries["x.md"].state).toBe("deleted");
	});

	it("Local 未变/Remote 变 → 接受 Remote 应用本地", () => {
		const b = snap({ "x.md": active(A) });
		const p = runPlan(b, snap({ "x.md": active(A) }), snap({ "x.md": active(B) }));
		expect(p.apply_actions).toEqual([{ kind: "write", path: "x.md", content_hash: B, size: "10" }]);
	});

	it("Local 未变/Remote 删除 → 本地移入回收站", () => {
		const b = snap({ "x.md": active(A) });
		const p = runPlan(b, snap({ "x.md": active(A) }), snap({ "x.md": deleted }));
		expect(p.apply_actions).toEqual([{ kind: "trash", path: "x.md", content_hash: "", size: "0" }]);
	});

	it("双方修改为相同结果 → 接受该结果，无冲突副本", () => {
		const b = snap({ "x.md": active(A) });
		const p = runPlan(b, snap({ "x.md": active(B) }), snap({ "x.md": active(B) }));
		expect(p.puts).toEqual([]);
		expect(p.conflict_copies).toEqual([]);
	});

	it("双方修改为不同内容 → Remote 保持原路径，Local 保存为冲突副本", () => {
		const b = snap({ "x.md": active(A) });
		const p = runPlan(b, snap({ "x.md": active(B) }), snap({ "x.md": active(C) }));
		expect(p.conflict_copies).toHaveLength(1);
		const cc = p.conflict_copies[0];
		expect(cc.source_path).toBe("x.md");
		expect(cc.content_hash).toBe(B);
		// 原路径保持 Remote 内容
		expect(p.target_entries["x.md"].content_hash).toBe(C);
		// 冲突副本进入目标 Manifest 并上传 Blob
		expect(p.puts.some((m) => m.path === cc.path)).toBe(true);
	});

	it("Local 修改、Remote 删除 → 修改胜：恢复/保留 Local 并重新提交 active", () => {
		const b = snap({ "x.md": active(A) });
		const p = runPlan(b, snap({ "x.md": active(B) }), snap({ "x.md": deleted }));
		expect(p.puts).toEqual([expect.objectContaining({ path: "x.md", content_hash: B, size: "10", kind: 1 })]);
		expect(p.apply_actions).toEqual([]);
	});

	it("Local 删除、Remote 修改 → 修改胜：接受 Remote", () => {
		const b = snap({ "x.md": active(A) });
		const p = runPlan(b, snap({ "x.md": deleted }), snap({ "x.md": active(B) }));
		expect(p.apply_actions).toEqual([{ kind: "write", path: "x.md", content_hash: B, size: "10" }]);
	});

	it("双方删除 → 保持 tombstone", () => {
		const b = snap({ "x.md": active(A) });
		const p = runPlan(b, snap({ "x.md": deleted }), snap({ "x.md": deleted }));
		expect(p.puts).toEqual([]);
		expect(p.deletes).toEqual([]);
		expect(p.target_entries["x.md"].state).toBe("deleted");
	});

	it("Base 无、双方同一路径创建不同内容 → Remote 保持，Local 冲突副本", () => {
		const p = runPlan(null, snap({ "x.md": active(A) }), snap({ "x.md": active(B) }));
		expect(p.conflict_copies).toHaveLength(1);
		expect(p.target_entries["x.md"].content_hash).toBe(B);
	});

	it("Base 无、Local 创建、Remote 为 tombstone → 冲突副本，不复活原路径", () => {
		const p = runPlan(null, snap({ "x.md": active(A) }), snap({ "x.md": deleted }));
		expect(p.conflict_copies).toHaveLength(1);
		expect(p.target_entries["x.md"].state).toBe("deleted");
	});

	it("rename 语义 = delete(old) + put(new, 同 file_id)", () => {
		const fid = "550e8400-e29b-41d4-a716-446655440000";
		const b = snap({ "old.md": { ...active(A), file_id: fid } });
		const l = snap({ "old.md": { state: "deleted" }, "new.md": { ...active(A), file_id: fid } });
		const r = snap({ "old.md": { ...active(A), file_id: fid } });
		const p = runPlan(b, l, r);
		expect(p.deletes).toEqual(["old.md"]);
		expect(p.puts).toEqual([{ path: "new.md", content_hash: A, size: "10", file_id: fid, kind: 1 }]);
		// file_id 不进 hash：rename 后 target_entries 保留身份
		expect(p.target_entries["new.md"].file_id).toBe(fid);
	});
});

describe("§8.4 Bootstrap（无 Base）", () => {
	it("仅本地存在 → 上传并加入目标 Snapshot", () => {
		const p = runPlan(null, snap({ "x.md": active(A) }), snap({}));
		expect(p.puts).toEqual([expect.objectContaining({ path: "x.md", content_hash: A, size: "10", kind: 1 })]);
	});

	it("仅远端 active → 下载到本地", () => {
		const p = runPlan(null, snap({}), snap({ "x.md": active(A) }));
		expect(p.apply_actions).toEqual([{ kind: "write", path: "x.md", content_hash: A, size: "10" }]);
	});

	it("两边同路径同 hash → 直接建立 Base，无操作", () => {
		const p = runPlan(null, snap({ "x.md": active(A) }), snap({ "x.md": active(A) }));
		expect(p.puts).toEqual([]);
		expect(p.apply_actions).toEqual([]);
		expect(p.conflict_copies).toEqual([]);
	});

	it("两边同路径不同 hash → Remote 保持原路径，Local 建冲突副本", () => {
		const p = runPlan(null, snap({ "x.md": active(A) }), snap({ "x.md": active(B) }));
		expect(p.conflict_copies).toHaveLength(1);
		expect(p.target_entries["x.md"].content_hash).toBe(B);
	});

	it("远端 tombstone、本地不存在 → 保持删除（trash 幂等）", () => {
		const p = runPlan(null, snap({}), snap({ "x.md": deleted }));
		expect(p.apply_actions).toEqual([{ kind: "trash", path: "x.md", content_hash: "", size: "0" }]);
		expect(p.target_entries["x.md"].state).toBe("deleted");
	});

	it("远端 tombstone、本地存在 → 冲突副本，不直接复活原路径", () => {
		const p = runPlan(null, snap({ "x.md": active(A) }), snap({ "x.md": deleted }));
		expect(p.conflict_copies).toHaveLength(1);
		expect(p.target_entries["x.md"].state).toBe("deleted");
	});

	it("无 Base 时不得推断历史删除：本地缺失路径不产生 delete", () => {
		// Local 无 Base 骨架，不会凭空出现 deleted；远端 tombstone 之外不删本地
		const p = runPlan(null, snap({}), snap({}));
		expect(p.deletes).toEqual([]);
	});
});

describe("目录条目（kind=2）", () => {
	const dir = (file_id?: string): Entry => ({ state: "active", kind: 2, file_id });

	it("仅本地空目录 → dir put（hash/size 为空，file_id 必填）", () => {
		const p = runPlan(null, snap({ notes: dir() }), snap({}));
		expect(p.puts).toEqual([
			expect.objectContaining({ path: "notes", content_hash: "", size: "0", kind: 2 }),
		]);
		expect(p.puts[0].file_id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("仅远端空目录 → mkdir 动作", () => {
		const p = runPlan(null, snap({}), snap({ notes: dir("550e8400-e29b-41d4-a716-446655440000") }));
		expect(p.apply_actions).toEqual([{ kind: "mkdir", path: "notes", content_hash: "", size: "0" }]);
		expect(p.target_entries["notes"].file_id).toBe("550e8400-e29b-41d4-a716-446655440000");
	});

	it("远端目录删除 → rmdir 动作（保留 kind）", () => {
		const b = snap({ notes: dir() });
		const p = runPlan(b, snap({ notes: dir() }), snap({ notes: { state: "deleted", kind: 2 } }));
		expect(p.apply_actions).toEqual([{ kind: "rmdir", path: "notes", content_hash: "", size: "0" }]);
		expect(p.target_entries["notes"].state).toBe("deleted");
	});

	it("apply_actions 按 mkdir→write→trash→rmdir 排序（pending 重放确定性）", () => {
		const fid = "550e8400-e29b-41d4-a716-446655440000";
		const b = snap({});
		const p = runPlan(
			b,
			snap({}),
			snap({
				"notes/a.md": active(A),
				notes: dir(fid),
				"old.md": deleted,
				"olddir": { state: "deleted", kind: 2 },
			}),
		);
		expect(p.apply_actions.map((a) => a.kind)).toEqual(["mkdir", "write", "trash", "rmdir"]);
	});

	it("entriesEqual 比较 kind：file 与 dir 同名不等", () => {
		expect(entriesEqual(active(A), { ...active(A), kind: 2 })).toBe(false);
		expect(entriesEqual(dir(), dir())).toBe(true);
		// 不比较 file_id：两侧独立生成同内容 file_id 不同仍视为相等
		expect(entriesEqual({ ...active(A), file_id: "x" }, { ...active(A), file_id: "y" })).toBe(true);
	});
});

describe("阻塞路径（§9.2/§16.5）", () => {
	it("超限/读失败路径保留 Base/Remote 原状态，禁止提交 delete", () => {
		const b = snap({ "big.zip": active(A) });
		const p = plan({
			base: b,
			local: snap({ "big.zip": active(A) }),
			remote: snap({ "big.zip": active(A) }),
			deviceId: "dev-001",
			blockedPaths: ["big.zip"],
		});
		expect(p.deletes).toEqual([]);
		expect(p.blocked_paths).toEqual(["big.zip"]);
		expect(p.target_entries["big.zip"].state).toBe("active");
	});
});

describe("冲突副本命名（§8.2）", () => {
	it("格式 <stem> (conflict <device 短码> <UTC 时间>).<ext>，重名递增", () => {
		const now = new Date("2026-08-28T12:00:00.000Z");
		const n1 = nextConflictCopyName("daily/note.md", "abcdef-1234", now, new Set());
		expect(n1).toBe("daily/note (conflict abcdef 2026-08-28T12-00-00-000Z).md");
		const n2 = nextConflictCopyName("daily/note.md", "abcdef-1234", now, new Set([n1]));
		expect(n2).toBe("daily/note (conflict abcdef 2026-08-28T12-00-00-000Z 2).md");
	});

	it("entriesEqual 只比较 state+content_hash+size，忽略 local_* 快路径字段", () => {
		const a: Entry = { state: "active", content_hash: A, size: "10", local_mtime: "1", local_size: "10" };
		const b: Entry = { state: "active", content_hash: A, size: "10", local_mtime: "999", local_size: "10" };
		expect(entriesEqual(a, b)).toBe(true);
		expect(entriesEqual(a, { ...a, content_hash: B })).toBe(false);
		expect(entriesEqual(deleted, deleted)).toBe(true);
	});
});

describe("目录重命名与空壳清理", () => {
	const dir = (file_id?: string): Entry => ({ state: "active", kind: 2, file_id });
	const deletedDir = (): Entry => ({ state: "deleted", kind: 2 });

	it("非空目录重命名 A 视角：delete(旧目录+子文件) + put(新目录+子文件，file_id 继承)", () => {
		const f1 = "550e8400-e29b-41d4-a716-446655440000";
		const f2 = "550e8400-e29b-41d4-a716-446655440001";
		const d1 = "550e8400-e29b-41d4-a716-446655440002";
		const b = snap({
			a: dir(d1),
			"a/x.md": { ...active(A), file_id: f1 },
			"a/y.md": { ...active(B), file_id: f2 },
		});
		const p = runPlan(
			b,
			snap({
				a: deletedDir(),
				"a/x.md": deleted,
				"a/y.md": deleted,
				b: dir(d1),
				"b/x.md": { ...active(A), file_id: f1 },
				"b/y.md": { ...active(B), file_id: f2 },
			}),
			b,
		);
		expect(p.deletes).toEqual(expect.arrayContaining(["a", "a/x.md", "a/y.md"]));
		expect(p.puts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "b", kind: 2, file_id: d1 }),
				expect.objectContaining({ path: "b/x.md", file_id: f1 }),
				expect.objectContaining({ path: "b/y.md", file_id: f2 }),
			]),
		);
		expect(p.apply_actions).toEqual([]); // A 端无 trash → 不追加 rmdir
	});

	it("非空目录重命名 B 视角：mkdir→write→trash→rmdir 顺序，旧目录 tombstone", () => {
		const b = snap({
			a: dir(),
			"a/x.md": active(A),
			"a/y.md": active(B),
		});
		const p = runPlan(
			b,
			b,
			snap({
				a: deletedDir(),
				"a/x.md": deleted,
				"a/y.md": deleted,
				b: dir(),
				"b/x.md": active(A),
				"b/y.md": active(B),
			}),
		);
		expect(p.apply_actions.map((a) => a.kind)).toEqual(["mkdir", "write", "write", "trash", "trash", "rmdir"]);
		const rmdirs = p.apply_actions.filter((a) => a.kind === "rmdir");
		expect(rmdirs).toHaveLength(1); // applyRemote 已有 rmdir a，追加逻辑去重
		expect(rmdirs[0].path).toBe("a");
		expect(p.target_entries["a"].state).toBe("deleted");
		expect(p.target_entries["b"].state).toBe("active");
	});

	it("trash 父目录无行（未物化）→ 追加 rmdir 清扫空壳", () => {
		const b = snap({ "a/x.md": active(A) });
		const p = runPlan(b, b, snap({ "a/x.md": deleted }));
		expect(p.apply_actions.map((a) => a.kind)).toEqual(["trash", "rmdir"]);
		expect(p.apply_actions[1].path).toBe("a");
	});

	it("trash 父目录已 tombstone → 既有 rmdir 去重不重复追加", () => {
		const b = snap({ a: dir(), "a/x.md": active(A) });
		const p = runPlan(b, b, snap({ a: deletedDir(), "a/x.md": deleted }));
		expect(p.apply_actions.filter((a) => a.kind === "rmdir")).toHaveLength(1);
	});

	it("trash 父目录 active dir（用户保留）→ 不追加 rmdir", () => {
		const b = snap({ a: dir(), "a/x.md": active(A) });
		const p = runPlan(b, b, snap({ a: dir(), "a/x.md": deleted }));
		expect(p.apply_actions.map((a) => a.kind)).toEqual(["trash"]);
	});

	it("trash 父目录下有 active 后代 → 不追加 rmdir", () => {
		const b = snap({ "a/x.md": active(A), "a/y.md": active(B) });
		const p = runPlan(b, b, snap({ "a/x.md": deleted, "a/y.md": active(B) }));
		expect(p.apply_actions.map((a) => a.kind)).toEqual(["trash"]);
	});

	it("trash 父目录下后代全部 deleted → 追加 rmdir", () => {
		const b = snap({ "a/x.md": active(A), "a/y.md": active(B) });
		const p = runPlan(b, b, snap({ "a/x.md": deleted, "a/y.md": deleted }));
		expect(p.apply_actions.filter((a) => a.kind === "rmdir").map((a) => a.path)).toEqual(["a"]);
	});

	it("嵌套空壳 rmdir 按深度降序（深者先删，父先删会被非空子目录挡住且永不重试）", () => {
		const b = snap({ "a/x.md": active(A), "a/b/y.md": active(B) });
		const p = runPlan(b, b, snap({ "a/x.md": deleted, "a/b/y.md": deleted }));
		// trash a/x.md → 追加 rmdir a；trash a/b/y.md → 追加 rmdir a/b
		expect(p.apply_actions.filter((a) => a.kind === "rmdir").map((a) => a.path)).toEqual(["a/b", "a"]);
		expect(p.apply_actions.map((a) => a.kind)).toEqual(["trash", "trash", "rmdir", "rmdir"]);
	});

	it("既有 rmdir 与追加 rmdir 混排按深度降序", () => {
		const b = snap({ a: dir(), "a/b": dir(), "a/b/x.md": active(A) });
		const p = runPlan(b, b, snap({ a: deletedDir(), "a/b": deletedDir(), "a/b/x.md": deleted }));
		// applyRemote：rmdir a、rmdir a/b、trash a/b/x.md；追加：a/b 已 seen 去重
		expect(p.apply_actions.filter((a) => a.kind === "rmdir").map((a) => a.path)).toEqual(["a/b", "a"]);
	});

	it("冲突副本（active 同级）不误触发 rmdir", () => {
		const l = snap({ "a/x.md": active(B) });
		const p = runPlan(null, l, snap({ "a/x.md": deleted }));
		// Bootstrap：远端 tombstone + 本地内容 → 冲突副本 + trash 原路径
		expect(p.apply_actions.some((a) => a.kind === "trash" && a.path === "a/x.md")).toBe(true);
		expect(p.conflict_copies.length).toBeGreaterThan(0);
		expect(p.apply_actions.filter((a) => a.kind === "rmdir")).toHaveLength(0);
	});

	it("根级文件 trash 无父目录不追加 rmdir", () => {
		const b = snap({ "x.md": active(A) });
		const p = runPlan(b, b, snap({ "x.md": deleted }));
		expect(p.apply_actions.map((a) => a.kind)).toEqual(["trash"]);
	});
});

describe("file_id 身份冲突（12023 防触发）", () => {
	const dir = (file_id?: string): Entry => ({ state: "active", kind: 2, file_id });
	const F = "550e8400-e29b-41d4-a716-4466554400f0";
	const G = "550e8400-e29b-41d4-a716-4466554400f1";
	const UUID_RE = /^[0-9a-f-]{36}$/;

	it("mkdir(未命名)+rename 交错：旧路径残留 active，新路径继承身份 → 改新 UUID（本次 bug 主场景）", () => {
		// base 有"未命名"=F（已提交）；local 中"未命名"残留 active（Obsidian 索引临时目录），
		// dir 经 rename hint 继承 F → 只发 put(dir, F) 无配对 delete 会被服务端 12023 拒绝
		const b = snap({ "未命名": dir(F) });
		const p = runPlan(
			b,
			snap({ "未命名": dir(F), dir: dir(F) }),
			snap({ "未命名": dir(F) }),
		);
		expect(p.deletes).toEqual([]); // 残留目录不误删
		expect(p.puts).toHaveLength(1);
		expect(p.puts[0].path).toBe("dir");
		expect(p.puts[0].file_id).not.toBe(F); // 身份被占用且未配对 delete → 强制新身份
		expect(p.puts[0].file_id).toMatch(UUID_RE);
		expect(p.target_entries["dir"].file_id).toBe(p.puts[0].file_id); // puts 与 target_entries 一致
		expect(p.target_entries["未命名"].file_id).toBe(F); // 原路径身份不动
	});

	it("合法 rename 配对（delete old + put new 同 file_id）→ 身份保持不误伤", () => {
		const b = snap({ "old.md": { ...active(A), file_id: F } });
		const l = snap({ "old.md": { state: "deleted" }, "new.md": { ...active(A), file_id: F } });
		const p = runPlan(b, l, b);
		expect(p.deletes).toEqual(["old.md"]);
		expect(p.puts).toEqual([{ path: "new.md", content_hash: A, size: "10", file_id: F, kind: 1 }]);
	});

	it("合法配对与非法复用并存：互不干扰", () => {
		const b = snap({
			"old.md": { ...active(A), file_id: F },
			"未命名": dir(G),
		});
		const l = snap({
			"old.md": { state: "deleted" },
			"new.md": { ...active(A), file_id: F },
			"未命名": dir(G),
			dir: dir(G),
		});
		const p = runPlan(b, l, b);
		expect(p.deletes).toEqual(["old.md"]);
		const newMd = p.puts.find((m) => m.path === "new.md")!;
		const dirPut = p.puts.find((m) => m.path === "dir")!;
		expect(newMd.file_id).toBe(F); // 配对 move 保身份
		expect(dirPut.file_id).not.toBe(G); // 未配对复用 → 新身份
		expect(p.target_entries["dir"].file_id).toBe(dirPut.file_id);
	});

	it("同 commit 双 put 复用同一 file_id（双 hint 指向同一旧路径）→ 仅先者保身份", () => {
		const b = snap({ "未命名": dir(F) });
		const l = snap({ "未命名": { state: "deleted", kind: 2 }, dir: dir(F), dir2: dir(F) });
		const p = runPlan(b, l, b);
		expect(p.deletes).toEqual(["未命名"]);
		expect(p.puts).toHaveLength(2);
		const kept = p.puts.filter((m) => m.file_id === F);
		expect(kept).toHaveLength(1); // 配对 delete 允许一个继承
		const fresh = p.puts.filter((m) => m.file_id !== F);
		expect(fresh).toHaveLength(1);
		expect(fresh[0].file_id).toMatch(UUID_RE);
		expect(p.target_entries[fresh[0].path].file_id).toBe(fresh[0].file_id);
		expect(p.target_entries[kept[0].path].file_id).toBe(F);
	});

	it("remote 历史脏数据双 active 同 file_id：就地修改也改新 UUID（服务端映射序不可预判）", () => {
		const b = snap({
			"x.md": { ...active(A), file_id: F },
			"y.md": { ...active(A), file_id: F },
		});
		const l = snap({
			"x.md": { ...active(A), file_id: F },
			"y.md": { ...active(B), file_id: F },
		});
		const p = runPlan(b, l, b);
		expect(p.deletes).toEqual([]);
		expect(p.puts).toHaveLength(1);
		expect(p.puts[0].path).toBe("y.md");
		expect(p.puts[0].file_id).not.toBe(F); // 双 owner 未全删：不能保身份
		expect(p.target_entries["y.md"].file_id).toBe(p.puts[0].file_id);
	});

	it("脏数据全清：双 owner 全部配对 delete → 身份合法继承", () => {
		const b = snap({
			"x.md": { ...active(A), file_id: F },
			"y.md": { ...active(A), file_id: F },
		});
		const l = snap({
			"x.md": { state: "deleted" },
			"y.md": { state: "deleted" },
			"z.md": { ...active(A), file_id: F },
		});
		const p = runPlan(b, l, b);
		expect(p.deletes).toEqual(expect.arrayContaining(["x.md", "y.md"]));
		expect(p.puts).toHaveLength(1);
		expect(p.puts[0].file_id).toBe(F); // 全部占用路径配对删除 → 继承合法
	});

	it("就地修改（同路径同身份）→ file_id 保持", () => {
		const b = snap({ "x.md": { ...active(A), file_id: F } });
		const p = runPlan(b, snap({ "x.md": { ...active(B), file_id: F } }), b);
		expect(p.puts).toHaveLength(1);
		expect(p.puts[0].file_id).toBe(F);
	});

	it("blocked 路径占用身份（不产生 delete）→ 新路径改新 UUID", () => {
		const b = snap({ "未命名": dir(F) });
		const p = plan({
			base: b,
			local: snap({ "未命名": dir(F), dir: dir(F) }),
			remote: snap({ "未命名": dir(F) }),
			deviceId: "dev-001",
			blockedPaths: ["未命名"],
		});
		expect(p.deletes).toEqual([]);
		expect(p.puts).toHaveLength(1);
		expect(p.puts[0].path).toBe("dir");
		expect(p.puts[0].file_id).not.toBe(F); // blocked 不产生 delete → 身份必然不可配对
		expect(p.target_entries["未命名"].state).toBe("active"); // 阻塞路径保留原状态
	});
});

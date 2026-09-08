// 三方对账 Planner（spec §8）：B = Base、L = Local、R = Remote 裁决生成目标 Snapshot
// 与 SyncPlan。纯函数、表驱动可测；不使用 mtime 选 winner（条目相等只比较
// state + kind + content_hash + size，不比较 file_id），冲突保留双副本（spec §1 决策 9）。
// rename 语义 = delete(oldPath) + put(newPath, 同 file_id)：身份由 file_id 承载，
// local-snapshot 通过 renameHints 继承旧路径 file_id，planner 原样透传（§8.3 扩展）。
// 对账后统一做 file_id 身份冲突修复（§8.3 扩展）：非法身份复用（服务端 12023）改新 UUID。

import { KIND_DIR, KIND_FILE } from "./types";
import type { Entry, PutMutation, Snapshot, SyncPlan } from "./types";
import { newUUID } from "./utils";

export interface PlanInput {
	base: Snapshot | null;
	local: Snapshot;
	remote: Snapshot;
	deviceId: string;
	/** 本地被阻塞路径（超限/读失败/大小写冲突）：保留 Base/Remote 原状态，禁止提交 delete（§9.2） */
	blockedPaths?: string[];
	now?: Date; // 测试注入
}

/** 条目语义相等：state + kind + content_hash + size（不含 file_id/mtime/local_* 字段，§8.1） */
export function entriesEqual(a: Entry | undefined, b: Entry | undefined): boolean {
	if (!a || !b) return false;
	if (a.state !== b.state) return false;
	if ((a.kind ?? KIND_FILE) !== (b.kind ?? KIND_FILE)) return false;
	if (a.state === "deleted") return true;
	return a.content_hash === b.content_hash && a.size === b.size;
}

/**
 * 三方对账（§8.2 裁决矩阵 + §8.4 Bootstrap）。返回：
 * - puts/deletes：提交给服务端的 mutations
 * - apply_actions：本地应用动作（write：临时文件落盘；trash：移入回收站）
 * - conflict_copies：Local 内容保存为冲突副本（Remote 保持原路径）
 * - target_entries：目标 Snapshot 完整 entries（CAS 成功后写为新 Base 的基础）
 * - blocked_paths：被阻塞路径
 */
export function plan(input: PlanInput): SyncPlan {
	const { base, local, remote, deviceId } = input;
	const now = input.now ?? new Date();
	const blockedSet = new Set(input.blockedPaths ?? []);

	const puts: PutMutation[] = [];
	const deletes: string[] = [];
	const applyActions: SyncPlan["apply_actions"] = [];
	const conflictCopies: { path: string; source_path: string; content_hash: string; size: string }[] = [];
	const targetEntries: Record<string, Entry> = { ...remote.entries };
	const usedNames = new Set<string>([...Object.keys(targetEntries), ...Object.keys(local.entries)]);

	const putLocal = (path: string, e: Entry): void => {
		const kind = e.kind ?? KIND_FILE;
		const fileId = e.file_id ?? newUUID();
		const contentHash = kind === KIND_DIR ? "" : e.content_hash!;
		const size = kind === KIND_DIR ? "0" : e.size!;
		puts.push({ path, content_hash: contentHash, size, file_id: fileId, kind });
		targetEntries[path] = {
			state: "active",
			content_hash: kind === KIND_DIR ? undefined : e.content_hash,
			size: kind === KIND_DIR ? undefined : e.size,
			kind,
			file_id: fileId,
		};
	};

	const applyRemote = (path: string, r: Entry): void => {
		if (r.state === "active") {
			if ((r.kind ?? KIND_FILE) === KIND_DIR) {
				applyActions.push({ kind: "mkdir", path, content_hash: "", size: "0" });
				targetEntries[path] = { state: "active", kind: KIND_DIR, file_id: r.file_id };
			} else {
				applyActions.push({ kind: "write", path, content_hash: r.content_hash!, size: r.size! });
				targetEntries[path] = {
					state: "active",
					content_hash: r.content_hash,
					size: r.size,
					kind: r.kind,
					file_id: r.file_id,
				};
			}
		} else {
			// 远端 tombstone：目录删空目录，文件移回收站
			applyActions.push({ kind: (r.kind ?? KIND_FILE) === KIND_DIR ? "rmdir" : "trash", path, content_hash: "", size: "0" });
			targetEntries[path] = { state: "deleted", kind: r.kind };
		}
	};

	const conflictCopy = (path: string, l: Entry, r: Entry): void => {
		if (l.state !== "active" || (l.kind ?? KIND_FILE) === KIND_DIR) return; // dir 无内容可保全
		const copyPath = nextConflictCopyName(path, deviceId, now, usedNames);
		usedNames.add(copyPath);
		// 冲突副本是新文件，必须新 file_id：沿用源 file_id 会与保留在原路径的
		// Remote 行冲突（服务端拒绝同一 file_id 出现在两条 active 路径，12023）
		const copyFileId = newUUID();
		conflictCopies.push({
			path: copyPath,
			source_path: path,
			content_hash: l.content_hash!,
			size: l.size!,
		});
		puts.push({ path: copyPath, content_hash: l.content_hash!, size: l.size!, file_id: copyFileId, kind: KIND_FILE });
		targetEntries[copyPath] = { state: "active", content_hash: l.content_hash, size: l.size, kind: KIND_FILE, file_id: copyFileId };
		// 原路径写回 Remote 状态（保持 X / trash 原文件）：磁盘必须与 target_entries 一致，
		// 否则下一轮对账会把冲突输家内容当普通修改重新提交，覆盖 Remote 内容
		applyRemote(path, r);
	};

	// candidate = union(diff(B,L), diff(B,R))：逐路径比较（条目级遍历，O(n)）
	const candidate = new Set<string>([
		...Object.keys(local.entries),
		...Object.keys(remote.entries),
		...(base ? Object.keys(base.entries) : []),
	]);
	for (const p of candidate) {
		if (blockedSet.has(p)) {
			// 本地状态未知：保留 Base/Remote 原状态，禁止提交 delete/put（§9.2）
			const keep = base?.entries[p] ?? remote.entries[p];
			if (keep) targetEntries[p] = keep;
			continue;
		}
		const b = base?.entries[p];
		const l = local.entries[p];
		const r = remote.entries[p];

		if (!b) {
			// ===== Base 无该路径（首次绑定/新建，§8.4 Bootstrap 语义）=====
			if (l && r) {
				if (entriesEqual(l, r)) continue; // 两边同路径同 hash：直接建立
				if (l.state === "deleted") {
					applyRemote(p, r); // Local 继承的 tombstone 与 Remote 不同：接受 Remote
					continue;
				}
				if (r.state === "deleted") {
					// 远端 tombstone、本地存在：本地内容为未知来源，保留为冲突副本，不复活原路径
					conflictCopy(p, l, r);
					continue;
				}
				// 双方创建不同内容：Remote 保持原路径，Local 保存为冲突副本
				conflictCopy(p, l, r);
				continue;
			}
			if (l && !r) {
				if (l.state === "active") putLocal(p, l);
				continue; // 仅本地 tombstone 且远端无记录：无操作
			}
			if (!l && r) {
				applyRemote(p, r); // 仅远端 active → 下载；远端 tombstone → 本地无文件，trash 幂等
				continue;
			}
			continue;
		}

		// ===== Base 有该路径（§8.2 裁决矩阵）=====
		if (!l) {
			// Local 无记录（被阻塞路径已在上面处理；此处防御）：保留 Remote 状态
			continue;
		}
		const lChanged = !entriesEqual(b, l);
		const rChanged = !entriesEqual(b, r);
		if (!lChanged && !rChanged) continue; // 未变：无操作
		if (lChanged && !rChanged) {
			// 仅 Local 变：接受 Local
			if (l.state === "active") putLocal(p, l);
			else deletes.push(p), (targetEntries[p] = { state: "deleted", kind: l.kind }); // Local 删除、Remote 未变 → 删除远端
			continue;
		}
		if (!lChanged && rChanged) {
			applyRemote(p, r); // 仅 Remote 变：接受 Remote
			continue;
		}
		// ===== 双方都变 =====
		if (entriesEqual(l, r)) continue; // 双方修改为相同结果：接受该结果
		if (l.state === "deleted" && r.state === "deleted") continue; // 双方删除：保持 tombstone
		if (l.state === "deleted") {
			applyRemote(p, r); // Local 删除、Remote 修改 → 修改胜：接受 Remote
			continue;
		}
		if (r.state === "deleted") {
			putLocal(p, l); // Local 修改、Remote 删除 → 修改胜：恢复/保留 Local 并重新提交 active
			continue;
		}
		// 双方修改为不同内容：Remote 保持原路径；Local 保存为冲突副本
		conflictCopy(p, l, r);
	}

	// ===== file_id 身份冲突修复（12023 防触发，spec §8.3 扩展）=====
	// 协议规则：put 的 file_id 已 active 于其他路径且该路径未在本 commit 配对
	// delete → 服务端拒绝（12023）。rename 的 delete(old)+put(new, 同 file_id)
	// 是合法配对（§8.3），本修复只处理非法复用：
	//   1. 身份被 remote 其他 active 路径占用且未配对 delete → 新路径改新 UUID
	//      （Remote 原路径身份不动，同步正确性无损，仅该路径历史链断——同冲突副本先例 93 行）；
	//   2. 同 commit 两个 put 复用同一 file_id（两条 rename hint 指向同一旧路径，
	//      例：mkdir(未命名)+rename 快速交错）→ 仅先提交者保身份，其余改新 UUID
	//      （服务端不拒绝，但同一 file_id 出现于两条 active 路径后，后续 move 必触发
	//      12023，源头切断）；
	//   3. remote 侧已存在双 active 同 file_id（历史脏数据）→ 身份不可再继承，
	//      除非全部占用路径都在本轮配对 delete（服务端对占用路径的裁决顺序客户端
	//      不可复现，只有全删才保证不 12023；就地修改的路径自身不算"被删"）。
	// 必须在 candidate 循环结束后执行：此时 deletes 已完备（putLocal 调用时可能尚未生成）。
	const ownersByFileId = new Map<string, string[]>(); // file_id → remote active 占用路径
	for (const [p, e] of Object.entries(remote.entries)) {
		if (e.state !== "active" || !e.file_id) continue;
		const list = ownersByFileId.get(e.file_id);
		if (list) list.push(p);
		else ownersByFileId.set(e.file_id, [p]);
	}
	const deleteSet = new Set(deletes);
	const claimed = new Map<string, string>(); // 本轮已保留身份 → 路径（同 commit 查重）
	for (const m of puts) {
		const owners = ownersByFileId.get(m.file_id) ?? [];
		// 可保留身份的条件：全新身份 / 占用路径===本路径（就地）或已配对 delete / 多占用全部配对 delete
		const keepIdentity = owners.every((o) => o === m.path || deleteSet.has(o));
		if (!keepIdentity) {
			// 非法复用（规则 1/3）：身份被占用且本轮不删除占用者 → 新路径改新 UUID
			const fresh = newUUID();
			m.file_id = fresh;
			if (targetEntries[m.path]) targetEntries[m.path].file_id = fresh;
			continue; // fresh 与 remote/本轮均不冲突，跳过登记
		}
		const prev = claimed.get(m.file_id);
		if (prev !== undefined && prev !== m.path) {
			// 规则 2：同 commit 双 put 复用同一 file_id → 后者改新 UUID
			const fresh = newUUID();
			m.file_id = fresh;
			if (targetEntries[m.path]) targetEntries[m.path].file_id = fresh;
			continue;
		}
		claimed.set(m.file_id, m.path);
	}

	// trash 后父目录成为空壳 → 追加 rmdir 兜底清扫（仅本地执行，不进 mutations，服务端无感知）。
	// 统一物化下主路径靠 dir 行 tombstone 收敛，此处兜底 rmdir 被 skip 后的重试与交错残留；
	// pending 重放幂等（applier 对不存在目录短路成功）
	const rmdirSeen = new Set(applyActions.filter((a) => a.kind === "rmdir").map((a) => a.path));
	for (const a of [...applyActions]) {
		if (a.kind !== "trash") continue;
		const slash = a.path.lastIndexOf("/");
		if (slash <= 0) continue; // 根级文件无父目录
		const parent = a.path.slice(0, slash);
		if (rmdirSeen.has(parent)) continue;
		const tp = targetEntries[parent];
		if (tp && tp.state === "active") continue; // 父行 active（含 file 行）：用户保留的目录不删
		const hasActiveDescendant = Object.keys(targetEntries).some(
			(p) => p.startsWith(parent + "/") && targetEntries[p].state === "active",
		);
		if (hasActiveDescendant) continue; // 仍有 active 后代（§7.1 合法态/冲突副本/blocked）：不删
		rmdirSeen.add(parent);
		applyActions.push({ kind: "rmdir", path: parent, content_hash: "", size: "0" });
	}

	// 动作按依赖序稳定排序：mkdir → write → trash → rmdir（保证 pending 重放确定性，
	// applier 单遍执行即可；目录先建后写、文件先清后删目录）；
	// 同 kind 的 rmdir 按路径深度降序（深者先删）：父目录先删会被非空子目录挡住，
	// 且该 skip 永不重试（l==r==deleted 不再生成动作），必须先清后代
	const actionOrder: Record<SyncPlan["apply_actions"][number]["kind"], number> = {
		mkdir: 0,
		write: 1,
		trash: 2,
		rmdir: 3,
	};
	const depthOf = (p: string): number => p.split("/").length;
	applyActions.sort((x, y) => {
		const d = actionOrder[x.kind] - actionOrder[y.kind];
		if (d !== 0) return d;
		if (x.kind === "rmdir") return depthOf(y.path) - depthOf(x.path);
		return 0;
	});

	return {
		puts,
		deletes,
		target_root_hash: "", // 由调用方（session）基于 target_entries 计算填充
		target_entries: targetEntries,
		apply_actions: applyActions,
		conflict_copies: conflictCopies,
		blocked_paths: [...blockedSet],
		downloads: [], // 由 session 从 apply_actions 的 write 推导
	};
}

/** 冲突副本命名：<stem> (conflict <device 短码> <UTC 时间>).<ext>；重名追加递增序号（spec §8.2） */
export function nextConflictCopyName(
	path: string,
	deviceId: string,
	now: Date,
	used: Set<string>,
): string {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const baseName = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = baseName.lastIndexOf(".");
	const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
	const ext = dot > 0 ? baseName.slice(dot) : "";
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const short = deviceId.slice(0, 6);
	let name = `${dir}${stem} (conflict ${short} ${stamp})${ext}`;
	for (let i = 2; used.has(name); i++) {
		name = `${dir}${stem} (conflict ${short} ${stamp} ${i})${ext}`;
	}
	return name;
}

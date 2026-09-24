// 冲突内容级合并（spec §8.2 扩展）：把 planner 产出的「双方改成不同内容 → 冲突副本」
// 中能在内容层干净合并的部分就地消解——原路径直接落合并结果，不再产生冲突副本。
//
// 位置：session 在 plan() 之后、计算 target_root_hash 之前调用。这一步会改写
// conflict_copies / puts / apply_actions / target_entries，因此必须早于 root 计算与
// expectedHashes 采集。
//
// 不变量：
// - **只在无冲突时替换**。diff3 判定存在冲突区，一律原样保留冲突副本，绝不产出半成品。
// - **plan 改写是原子的**。所有可失败的 I/O（读三份内容、加密、落临时区）全部先做完，
//   之后再纯内存改写；任一步抛错都不留「副本已摘除但产物未就绪」的中间状态。
//
// base 内容走服务端历史通道（GetBlob 的 history_file_id）：按 (file_id, 上次同步的
// content_hash) 取回共同祖先，免 expected Head 校验。代价是它受版本历史保留期约束
// （Free 10 天 / Pro 3 个月 / Max 12 个月），超期则退副本。

import { merge3Text } from "./merge3";
import { KIND_FILE } from "./types";
import type { Snapshot, SyncPlan } from "./types";

/** 合并大小上限：三份内容都要进内存，且行级 diff 最坏 O(n²) */
export const MERGE_MAX_BYTES = 1024 * 1024;

export interface MergeDeps {
	/** 本地当前内容（磁盘上即明文） */
	readLocal(path: string): Promise<Uint8Array>;
	/** Base 版本内容（远端历史通道，需 file_id + hash） */
	readBase(hash: string, fileId: string): Promise<Uint8Array>;
	/** 远端当前版本内容 */
	readRemote(hash: string): Promise<Uint8Array>;
	/** 明文 → 远端寻址信息（加密仓库为密文与密文哈希） */
	seal(content: Uint8Array): Promise<{ hash: string; bytes: Uint8Array }>;
	/** 合并产物落插件私有临时区（路径约定 <tmpDir>/<hash>，与下载产物一致） */
	stage(hash: string, bytes: Uint8Array): Promise<void>;
	/** 处置说明（跳过原因或合并结局；仅日志，不面向用户） */
	onNote?(path: string, message: string): void;
}

export interface MergePassResult {
	/** 本轮已就地合并、不再产生冲突副本的路径 */
	mergedPaths: Set<string>;
	/** 合并产物的 hash：已在临时区就绪，不得再走 GetBlob 下载 */
	stagedHashes: Set<string>;
}

const hasNul = (b: Uint8Array): boolean => b.includes(0);

/**
 * 逐个冲突副本尝试内容级合并。返回被消解的路径与已暂存的产物 hash。
 * 就地改写传入的 plan（与 session 对 target_root_hash 的处理方式一致）。
 */
export async function resolveConflictsByMerge(args: {
	plan: SyncPlan;
	base: Snapshot | null;
	remote: Snapshot;
	isConfigPath: (path: string) => boolean;
	deps: MergeDeps;
	maxBytes?: number;
}): Promise<MergePassResult> {
	const { plan, base, remote, isConfigPath, deps } = args;
	const maxBytes = args.maxBytes ?? MERGE_MAX_BYTES;
	const mergedPaths = new Set<string>();
	const stagedHashes = new Set<string>();
	const dropped = new Set<string>(); // 待摘除的冲突副本路径
	if (plan.conflict_copies.length === 0) return { mergedPaths, stagedHashes };

	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	// 同一 file_id 被多条 active 路径占用（历史脏数据）时的身份集合。
	// 合并产出的是「原路径的就地提交」，沿用远端的 file_id；若该身份还被别的 active 路径占着，
	// 服务端会以 12023 拒绝，而这条路径每轮都会算出同样的 put —— 会退化成死循环。
	// 这类路径一律退回冲突副本（与 planner 的 fix-up 同一原则：可疑身份不动）。
	const sharedFileIds = new Set<string>();
	{
		const seen = new Set<string>();
		for (const e of Object.values(remote.entries)) {
			if (e.state !== "active" || !e.file_id) continue;
			if (seen.has(e.file_id)) sharedFileIds.add(e.file_id);
			else seen.add(e.file_id);
		}
	}

	for (const cc of plan.conflict_copies) {
		// 冲突副本的 source_path 才是原路径（原路径远端胜、副本承载本地内容）
		const path = cc.source_path;
		const note = (message: string): void => deps.onNote?.(path, message);

		if (isConfigPath(path)) {
			note("配置文件冲突按远端胜处理，不参与内容合并");
			continue;
		}
		if (!path.toLowerCase().endsWith(".md")) {
			note("仅 .md 参与内容合并");
			continue;
		}
		// Base 记录是三方合并的前提：缺失即无共同祖先（首次绑定 / 换绑 / 已被裁剪）
		const b = base?.entries[path];
		const r = remote.entries[path];
		if (!b || b.state !== "active" || !b.content_hash || !b.file_id) {
			note("无可用 Base 版本（首次绑定或历史已裁剪）");
			continue;
		}
		if (!r || r.state !== "active" || !r.content_hash || !r.file_id) {
			note("远端不是 active 文件");
			continue;
		}
		if (sharedFileIds.has(r.file_id)) {
			note("file_id 身份被多条 active 路径占用，就地提交会触发 12023");
			continue;
		}
		// cc.size 是本地明文大小（planner 取自 Local 快照）
		const localSize = Number(cc.size);
		if (!Number.isFinite(localSize) || localSize > maxBytes) {
			note("超过合并大小上限");
			continue;
		}

		// ── 可失败的 I/O 段：全部完成前不改动 plan ──
		let sealed: { hash: string; bytes: Uint8Array };
		let sizeStr: string;
		try {
			const [localBytes, baseBytes, remoteBytes] = await Promise.all([
				deps.readLocal(path),
				deps.readBase(b.content_hash, b.file_id),
				deps.readRemote(r.content_hash),
			]);
			if (hasNul(localBytes) || hasNul(baseBytes) || hasNul(remoteBytes)) {
				note("内容含二进制字节，按文本合并不安全");
				continue;
			}
			const outcome = merge3Text(
				decoder.decode(baseBytes),
				decoder.decode(localBytes),
				decoder.decode(remoteBytes),
			);
			if (!outcome.clean || outcome.text === undefined) {
				note(`存在 ${outcome.conflictCount} 处冲突，保留冲突副本`);
				continue;
			}
			const mergedBytes = encoder.encode(outcome.text);
			sealed = await deps.seal(mergedBytes);
			// size 恒为明文大小（与 local-snapshot 的扫描口径一致）；加密仓库下只有 hash 是密文哈希
			sizeStr = String(mergedBytes.byteLength);
			// 产物已是本地/远端现有内容时无需落盘；否则先落临时区（最后一个可失败步骤）
			if (sealed.hash !== r.content_hash && sealed.hash !== cc.content_hash) {
				await deps.stage(sealed.hash, sealed.bytes);
				stagedHashes.add(sealed.hash);
			}
		} catch (err) {
			// 取 base 失败（超保留期 / 已 GC / 解密失败）、读盘失败等：降级为冲突副本，不中断本轮
			note(`合并失败：${err instanceof Error ? err.message : String(err)}`);
			continue;
		}

		// ── 纯内存改写段：此后不再有 await ──
		dropped.add(cc.path);
		mergedPaths.add(path);
		// file_id 沿用远端在原路径的身份：这是就地修改而非新建（沿用副本的新 UUID 会触发 12023）
		const fileId = r.file_id;
		if (sealed.hash === r.content_hash) {
			// 合并结果即远端内容：本地改动已被远端涵盖，保留原有「写远端内容」动作与目标条目
			note("合并结果与远端一致，按接受远端处理");
			continue;
		}
		const write = plan.apply_actions.find((a) => a.kind === "write" && a.path === path);
		if (sealed.hash === cc.content_hash) {
			// 合并结果即本地内容：磁盘已是该内容，摘掉远端覆盖动作，仅补一次提交
			if (write) plan.apply_actions.splice(plan.apply_actions.indexOf(write), 1);
			note("合并结果与本地一致，仅提交");
		} else {
			// 通用路径：原路径改写为合并结果
			if (write) {
				write.content_hash = sealed.hash;
				write.size = sizeStr;
			}
			note("已就地合并并保留双方改动");
		}
		plan.puts.push({
			path,
			content_hash: sealed.hash,
			size: sizeStr,
			file_id: fileId,
			kind: KIND_FILE,
		});
		plan.target_entries[path] = {
			state: "active",
			content_hash: sealed.hash,
			size: sizeStr,
			kind: KIND_FILE,
			file_id: fileId,
		};
	}

	if (dropped.size > 0) {
		plan.conflict_copies = plan.conflict_copies.filter((c) => !dropped.has(c.path));
		plan.puts = plan.puts.filter((p) => !dropped.has(p.path));
		for (const p of dropped) delete plan.target_entries[p];
	}
	return { mergedPaths, stagedHashes };
}

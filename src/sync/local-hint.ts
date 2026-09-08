// 本地 dirty hint（spec §5/§9.2）：Obsidian Vault 事件只维护内存 dirty_paths 并
// 请求运行 Session。事件不转换为 Change、不上传服务端、不写入操作队列或历史日志；
// 事件按固定防抖窗口请求一次 Session；插件自己写盘产生的事件允许再次进入 dirty
// 集合，由 mtime+size+content_hash 幂等消化（spec §9.2 自写抑制经 Session busy/dirty
// 再扫描自然吸收，不再使用 suppress map）。

import { TFolder, type EventRef, type Vault } from "obsidian";

import { debugLog } from "../debug-log";
import { normalize } from "../excludes";
import type { ReconcileSession } from "./session";

export class LocalHint {
	private readonly vault: Vault;
	private readonly session: ReconcileSession;
	private readonly debounceMs: () => number;
	private readonly registerEvent: (ref: EventRef) => void;
	private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
	private registered = false;
	/** 防抖窗口内出现过目录级 rename/delete → 触发时升级为 forceAudit
	 * （目录事件影响整棵子树路径，子文件事件可能跨轮/丢失，增量刷新会快照失真；
	 * 全量审计以磁盘枚举为准，目录级操作低频，mtime+size 快路径成本低） */
	private pendingForceAudit = false;

	constructor(
		vault: Vault,
		session: ReconcileSession,
		debounceMs: () => number,
		registerEvent: (ref: EventRef) => void,
	) {
		this.vault = vault;
		this.session = session;
		this.debounceMs = debounceMs;
		this.registerEvent = registerEvent;
	}

	/** 注册 vault 事件（必须 onLayoutReady 后调用：create 事件在 vault 加载时对每个
	 * 已存在文件触发一次，注册过早会有洪峰——洪峰无害但会白白触发一轮 Session）；
	 * 事件生命周期经 plugin.registerEvent 跟随插件卸载 */
	register(): void {
		if (this.registered) return;
		this.registered = true;
		this.registerEvent(
			this.vault.on("create", (file) => {
				this.session.addDirty(normalize(file.path));
				this.scheduleRequest();
			}),
		);
		this.registerEvent(
			this.vault.on("modify", (file) => {
				this.session.addDirty(normalize(file.path));
				this.scheduleRequest();
			}),
		);
		this.registerEvent(
			this.vault.on("delete", (file) => {
				// 目录删除影响整棵子树：升级 forceAudit 兜底（见 pendingForceAudit 注释）
				if (file instanceof TFolder) this.pendingForceAudit = true;
				this.session.addDirty(normalize(file.path));
				this.scheduleRequest();
			}),
		);
		this.registerEvent(
			this.vault.on("rename", (file, oldPath) => {
				// addDirtyRename：标脏两路径 + 记录 new→old 映射（file_id 继承保 rename 身份；
				// 若 hint 在本轮丢失只退化为新 file_id，同步正确性不受影响）。
				// 目录重命名影响整棵子树：升级 forceAudit 兜底（见 pendingForceAudit 注释）
				if (file instanceof TFolder) this.pendingForceAudit = true;
				this.session.addDirtyRename(normalize(oldPath), normalize(file.path));
				this.scheduleRequest();
			}),
		);
	}

	unload(): void {
		this.registered = false;
		for (const t of this.pending.values()) clearTimeout(t);
		this.pending.clear();
		this.pendingForceAudit = false;
	}

	/** 固定防抖窗口后请求 Session（同一路径重复事件在防抖窗口内自然合并）；
	 * 窗口内任一目录级 rename/delete 事件 → 升级为 forceAudit */
	private scheduleRequest(): void {
		clearTimeout(this.pending.get("*"));
		this.pending.set(
			"*",
			setTimeout(() => {
				this.pending.delete("*");
				const force = this.pendingForceAudit;
				this.pendingForceAudit = false;
				debugLog.info(`[pickpen][LocalHint] 防抖任务执行（forceAudit=${force}）`);
				this.session.requestRun(force ? { forceAudit: true } : undefined);
			}, this.debounceMs()),
		);
	}
}

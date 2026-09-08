// Snapshot 同步核心类型（spec §6）：所有 int64 字段一律十进制字符串，
// 禁止无检查转成可能溢出的 number。

/** 条目类型（int 枚举，1=file、2=dir；缺省按 file） */
export const KIND_FILE = 1;
export const KIND_DIR = 2;

/** Manifest 路径条目：active file 必含 content_hash/size；active dir 不含内容；deleted 是 tombstone */
export interface Entry {
	state: "active" | "deleted";
	content_hash?: string; // 64 位 hex（active file 必填）
	size?: string; // 十进制字符串（active file 必填）
	kind?: number; // KIND_FILE | KIND_DIR，缺省按 file
	file_id?: string; // 稳定身份（UUID，rename 不变），不参与 Merkle hash
	/** 仅 Base 快路径用（不参与远端语义与 Merkle hash，spec §6.4） */
	local_mtime?: string;
	local_size?: string;
}

/** Base Snapshot（sync-base.json，schema v2）与 Local/Remote Snapshot 的统一形状 */
export interface Snapshot {
	schema_version: 2;
	device_id: string;
	vault_id: string; // 十进制字符串
	base_revision: string;
	base_root_hash: string;
	entries: Record<string, Entry>;
}

/** 提交给服务端的 put mutation（spec §11.3） */
export interface PutMutation {
	path: string;
	content_hash: string; // dir 时为空
	size: string; // dir 时为 "0"
	file_id: string; // 客户端生成 UUID（必填）
	kind?: number; // KIND_FILE | KIND_DIR，缺省按 file
}

/** 本地应用动作（pending 日志逐条可重复执行，spec §9.4） */
export interface ApplyAction {
	kind: "write" | "trash" | "mkdir" | "rmdir";
	path: string;
	temp_path?: string; // write：插件私有临时区文件
	content_hash: string; // write：目标内容 hash（幂等判定）；mkdir/rmdir：空
	size: string; // write：目标内容字节数；mkdir/rmdir："0"
}

/** 冲突副本（planner 输出）：Local 内容保存到新路径，Remote 保持原路径 */
export interface ConflictCopy {
	path: string;
	source_path: string; // 本地源文件（applier 优先从源复制，源失效则 GetBlob）
	content_hash: string;
	size: string;
}

/** 三方对账结果（planner 输出） */
export interface SyncPlan {
	puts: PutMutation[];
	deletes: string[];
	/** 目标 Snapshot root hash（客户端计算，提交时服务端重算校验） */
	target_root_hash: string;
	/** 目标 Snapshot 完整 entries（CAS 成功后写为新 Base 的基础） */
	target_entries: Record<string, Entry>;
	/** 本地应用动作（下载写盘 / trash） */
	apply_actions: ApplyAction[];
	/** 冲突副本清单（apply_actions 之外的本地写入，内容与 put 同 hash） */
	conflict_copies: ConflictCopy[];
	/** 需要下载的 Remote Blob（session 从 apply_actions 的 write 推导填充） */
	downloads: DownloadItem[];
	/** 被阻塞路径（超限、读取失败、大小写冲突、file/dir 冲突）：UI 不得显示全部同步完成 */
	blocked_paths: string[];
}

/** sync-pending-v2.json（spec §9.4） */
export interface PendingLog {
	schema_version: 2;
	vault_id: string;
	base_revision: string;
	base_root_hash: string;
	target_root_hash: string;
	phase: "prepared" | "committed" | "applying";
	target_revision: string | null;
	apply_actions: ApplyAction[];
	created_at: string;
}

/** 下载计划项（planner 输出 → applier 消费） */
export interface DownloadItem {
	path: string;
	content_hash: string;
	size: string;
}

export const SNAPSHOT_SCHEMA_VERSION = 2;

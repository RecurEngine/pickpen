// Snapshot Fetcher（spec §7.6/§11）：Head / 完整 Manifest / Blob / Commit unary RPC。
// - GetManifest 收到 gzip 压缩的 manifest_json，解压后重建 Merkle Tree 校验
//   root hash == 响应 root hash，不符拒绝本轮同步（spec §7.6）
// - int64 全程 bigint，禁止 Number() 转换

import { create } from "@bufbuild/protobuf";
import {
	DeleteMutationSchema,
	EntryKind,
	MutationSchema,
	PutMutationSchema,
	type FileVersionInfo,
} from "../gen/proto/sync/sync.ext_pb";
import { isSnapshotChanged, type RemoteClient } from "../remote-connect";
import { buildTree, type Entry } from "./merkle";
import { KIND_DIR } from "./types";
import type { PutMutation } from "./types";

// RemoteSnapshotConfig SnapshotRemote 只读客户端配置（鉴权头由 RemoteClient 内部拦截器注入）
interface RemoteSnapshotConfig {
	baseUrl: string;
	accessToken: string;
	vaultId: string;
}

export interface RemoteHead {
	revision: bigint;
	rootHash: string;
	unchanged: boolean;
	/** 服务端建议的同步轮询间隔（ms）；0 = 未下发，沿用本地默认 */
	syncIntervalMs: bigint;
	maxFileSizeBytes: bigint;
	/** 服务端建议的本地变更防抖窗口（ms）；0 = 客户端使用默认值 */
	localDebounceMs: bigint;
}

export interface RemoteManifest {
	revision: bigint;
	rootHash: string;
	vaultId: string;
	entries: Record<string, Entry>;
}

export class SnapshotRemote {
	constructor(
		private readonly client: RemoteClient,
		private readonly getConfig: () => RemoteSnapshotConfig,
		private readonly onHead?: (head: RemoteHead) => void,
	) {}

	private get vaultId(): bigint {
		return BigInt(this.getConfig().vaultId);
	}

	/** 空轮询（spec §10）：只读 Head */
	async getHead(): Promise<RemoteHead | null> {
		const cfg = this.getConfig();
		if (!cfg.accessToken || !cfg.vaultId) return null;
		const resp = await this.client.syncClient.getVaultHead({
			vaultId: this.vaultId,
			knownRevision: 0n,
			knownRootHash: "",
		});
		const head = {
			revision: resp.revision,
			rootHash: resp.rootHash,
			unchanged: resp.unchanged,
			syncIntervalMs: resp.syncIntervalMs,
			maxFileSizeBytes: resp.maxFileSizeBytes,
			localDebounceMs: resp.localDebounceMs,
		};
		this.onHead?.(head);
		return head;
	}

	/** 轮询：携带 known Head，未变时不请求 Manifest */
	async pollHead(knownRevision: bigint, knownRootHash: string): Promise<RemoteHead | null> {
		const cfg = this.getConfig();
		if (!cfg.accessToken || !cfg.vaultId) return null;
		const resp = await this.client.syncClient.getVaultHead({
			vaultId: this.vaultId,
			knownRevision,
			knownRootHash,
		});
		const head = {
			revision: resp.revision,
			rootHash: resp.rootHash,
			unchanged: resp.unchanged,
			syncIntervalMs: resp.syncIntervalMs,
			maxFileSizeBytes: resp.maxFileSizeBytes,
			localDebounceMs: resp.localDebounceMs,
		};
		this.onHead?.(head);
		return head;
	}

	/**
	 * 下载完整 Manifest（gzip 解压 + 重建 Merkle 校验 root）。
	 * 12015（SNAPSHOT_CHANGED）原样抛出，由 session 从新 Head 重试。
	 */
	async getManifest(expectedRevision: bigint, expectedRootHash: string): Promise<RemoteManifest> {
		const resp = await this.client.syncClient.getManifest({
			vaultId: this.vaultId,
			expectedRevision,
			expectedRootHash,
		});
		const raw = await gunzip(resp.manifestJson);
		let parsed: {
			schema_version?: number;
			vault_id?: string;
			revision?: string;
			root_hash?: string;
			entries?: Record<string, Entry>;
		};
		try {
			parsed = JSON.parse(new TextDecoder().decode(raw));
		} catch {
			throw new Error("manifest JSON 解析失败");
		}
		if (parsed.schema_version !== 2 || !parsed.entries) {
			throw new Error("manifest 结构非法");
		}
		const { rootHash: computed } = buildTree(parsed.entries!);
		const root = await computed;
		if (root !== resp.rootHash) {
			// 服务端返回的 Manifest 与声明的 root 不符：拒绝本轮同步（spec §7.6）
			throw new Error(`manifest root 校验失败：计算 ${root} ≠ 声明 ${resp.rootHash}`);
		}
		return {
			revision: resp.revision,
			rootHash: resp.rootHash,
			vaultId: parsed.vault_id ?? "",
			entries: parsed.entries!,
		};
	}

	/** 批量确认 Blob 存在性 */
	async hasBlobs(hashes: string[]): Promise<Set<string>> {
		if (hashes.length === 0) return new Set();
		const resp = await this.client.syncClient.hasBlobs({ vaultId: this.vaultId, hashes });
		return new Set(resp.existing);
	}

	/** 预上传 Blob（同 hash 幂等，服务端重算 SHA-256 校验） */
	async putBlob(hash: string, content: Uint8Array): Promise<void> {
		await this.client.syncClient.putBlob({
			vaultId: this.vaultId,
			hash,
			size: BigInt(content.length),
			content,
		});
	}

	/** 下载 Blob（须携带 expected Head，服务端校验引用集；12012 = GC 竞态可恢复）；
	 * historyFileId 非空 = 读该 file_id 的历史版本（免 expected Head 校验） */
	async getBlob(
		hash: string,
		expectedRevision: bigint,
		expectedRootHash: string,
		historyFileId = "",
	): Promise<Uint8Array> {
		const resp = await this.client.syncClient.getBlob({
			vaultId: this.vaultId,
			hash,
			expectedRevision,
			expectedRootHash,
			historyFileId,
		});
		return resp.content;
	}

	/** 查询文件历史版本（created_at 倒序 keyset 分页；供历史查看 UI） */
	async listFileVersions(
		fileId: string,
		pageSize = 50,
		pageToken = "",
	): Promise<{ versions: FileVersionInfo[]; nextPageToken: string; hasMore: boolean }> {
		const resp = await this.client.syncClient.listFileVersions({
			vaultId: this.vaultId,
			fileId,
			pageSize: BigInt(pageSize),
			pageToken,
		});
		return { versions: resp.versions, nextPageToken: resp.nextPageToken, hasMore: resp.hasMore };
	}

	/**
	 * CAS 提交（spec §11.3）。12015 → 返回 null（调用方从新 Head 重试）；
	 * 12016（file/dir 冲突）→ 抛出供 session 标记 blocked；12017 → 抛出（预上传遗漏，防御）；
	 * 12023（file_id 身份冲突）→ 抛出供 session 特判（退避重对账 + hint 抑制）。
	 */
	async commitSnapshot(args: {
		expectedRevision: bigint;
		expectedRootHash: string;
		targetRootHash: string;
		puts: PutMutation[];
		deletes: string[];
	}): Promise<{ revision: bigint; rootHash: string; changed: boolean } | null> {
		try {
			const resp = await this.client.syncClient.commitSnapshot({
				vaultId: this.vaultId,
				expectedRevision: args.expectedRevision,
				expectedRootHash: args.expectedRootHash,
				targetRootHash: args.targetRootHash,
				mutations: [
					...args.puts.map((p) =>
						create(MutationSchema, {
							op: {
								case: "put",
								value: create(PutMutationSchema, {
									path: p.path,
									contentHash: p.content_hash,
									size: BigInt(p.size),
									fileId: p.file_id,
									kind: p.kind === KIND_DIR ? EntryKind.DIR : EntryKind.FILE,
								}),
							},
						}),
					),
					...args.deletes.map((p) =>
						create(MutationSchema, {
							op: { case: "delete", value: create(DeleteMutationSchema, { path: p }) },
						}),
					),
				],
			});
			return { revision: resp.revision, rootHash: resp.rootHash, changed: resp.changed };
		} catch (err) {
			if (isSnapshotChanged(err)) return null;
			throw err;
		}
	}
}

/** gzip 解压（DecompressionStream，桌面 Chromium / 移动端 WKWebView ≥ Safari 16.4） */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream !== "function") {
		throw new Error("当前环境不支持 gzip 解压（DecompressionStream）");
	}
	// 注意：bytes 可能是 protobuf 解码的 subarray 视图，必须传视图本身（Blob 取视图内容），
	// 传 bytes.buffer 会把帧头/trailer 等垃圾字节混入 gzip 流导致解压失败。
	// TS6 泛型 cast：运行时始终是真实 ArrayBuffer（同 content-hash.ts 注释）
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
	const buf = await new Response(stream).arrayBuffer();
	return new Uint8Array(buf);
}

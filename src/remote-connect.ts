// connect-web 客户端：createGrpcWebTransport（gRPC-Web 二进制帧，无 base64 膨胀）
// + createClient；authInterceptor 注入 Authorization: Bearer 头并自动刷新 access token；
// 仓库经请求体 vault_id 字段定位（Snapshot 同步 v2，spec §11）

import { createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { Platform } from "obsidian";

import { debugLog } from "./debug-log";
import { SyncService } from "./gen/proto/sync/sync.ext_pb";
import { SubscriptionService } from "./gen/proto/subscription/subscription_pb";
import { UserService } from "./gen/proto/user/user.ext_pb";

export interface RemoteConfig {
	baseUrl: string; // 必须 /api 结尾（后端 Web 协议统一挂 /api 前缀）
	pluginVersion: string; // 插件版本号（manifest.version），随请求头 Plugin-Version 发送
	accessToken: string;
	accessExpiresAtMs: number;
	vaultId: string; // 绑定仓库 ID（十进制字符串，调用处 BigInt()）
	// onUnauthenticated 刷新 token 对；成功 true（调用方重试原请求），失败 false
	onUnauthenticated: () => Promise<boolean>;
}

// 后端业务错误码：即 ConnectError.code 的线上值（与后端定义保持同步），判断只认码
export const ErrCode = {
	Internal: 10001,
	InvalidCredentials: 11001,          // 登录失败（参数/格式错误，或暂不支持的登录方式）
	InvalidOrMissingCredentials: 11002, // token 缺失/无效
	InvalidOrExpiredCode: 11003,        // 验证码错误或已过期
	SendCodeTooFrequent: 11004,         // 验证码发送过于频繁
	InvalidOrMissingVault: 12001,       // vault_id 缺失/非法（历史约定按未授权处理）
	InvalidPath: 12002,
	InvalidVaultName: 12003,
	VaultNotFound: 12004,     // 仓库不存在（不再惰性建仓）
	VaultNameAlreadyExists: 12005,
	InvalidHash: 12006,       // hash 非法 / PutBlob 声明 hash 与内容不符
	ContentSizeMismatch: 12007,
	FileNotFound: 12012,      // Manifest 引用但远端存储对象不存在（GC 竞态，重传可恢复）
	SnapshotChanged: 12015,   // SNAPSHOT_CHANGED：expected Head 失效，从新 Head 重试
	FileDirConflict: 12016,   // file/dir 冲突（含 tombstone 带 children 重建）
	BlobNotUploaded: 12017,   // Commit 引用了未上传的 hash
	ManifestMismatch: 12018,  // 重算 root 与声明不符 / 规范化冲突
	BlobTooLarge: 12019,      // 超过当前套餐单文件上限
	InvalidMutation: 12020,   // mutations 内部冲突
	BlobNotReferenced: 12021, // GetBlob 引用集外（越权）
	FileIDMoved: 12023,       // put 的 file_id 已 active 于其他路径且未配对 delete（move 兜底）
	VaultLimitExceeded: 12024,
	StorageLimitExceeded: 12025,
	InvalidSubscription: 13001,
	PaymentUnavailable: 13002,
	OrderNotFound: 13003,
	OrderExpired: 13004,
	PaymentCreateFailed: 13005,
	PaymentVerifyFailed: 13006,
} as const;

// errorCode 业务错误码（err.code 即业务码）
export function errorCode(err: unknown): number | undefined {
	return (err as { code?: number } | undefined)?.code;
}

// isUnauthenticated 判断需重新登录（令牌失效）：覆盖 11002/12001 两码。
// 11001 只可能出现在 Login RPC（登录 UI 内联分类）；access 过期由 authInterceptor 自动刷新，
// 走到这里的 11002 表示自动刷新也失败（refresh token 失效）。
export function isUnauthenticated(err: unknown): boolean {
	const c = errorCode(err);
	return c === ErrCode.InvalidOrMissingCredentials || c === ErrCode.InvalidOrMissingVault;
}

// isSnapshotChanged 判断 CAS/expected Head 失效（12015）：从新 Head 重试三方对账
export function isSnapshotChanged(err: unknown): boolean {
	return errorCode(err) === ErrCode.SnapshotChanged;
}

// isBlobNotFound 判断 Blob 缺失（12012，GC 竞态窗口）：重传该 Blob 即可恢复
export function isBlobNotFound(err: unknown): boolean {
	return errorCode(err) === ErrCode.FileNotFound;
}

// isBlobNotReferenced 判断历史版本内容不可读（12021，引用集外/超保留期已清理）
export function isBlobNotReferenced(err: unknown): boolean {
	return errorCode(err) === ErrCode.BlobNotReferenced;
}

// isFileDirConflict 判断 file/dir 冲突（12016）：路径被阻塞，不得无限重试
export function isFileDirConflict(err: unknown): boolean {
	return errorCode(err) === ErrCode.FileDirConflict;
}

// isFileIDMoved 判断 file_id 身份冲突（12023）：plan 非法复用身份，需重新对账并抑制 hint 继承
export function isFileIDMoved(err: unknown): boolean {
	return errorCode(err) === ErrCode.FileIDMoved;
}

/** isStorageLimitExceeded 判断用户总存储空间超过当前套餐上限。 */
export function isStorageLimitExceeded(err: unknown): boolean {
	return errorCode(err) === ErrCode.StorageLimitExceeded;
}

const PUBLIC_AUTH_METHODS = new Set([
	UserService.method.sendCode.name,
	UserService.method.login.name,
	UserService.method.refreshToken.name,
]);

// SendCode/Login/RefreshToken 不依赖 access token。尤其 RefreshToken 必须旁路自动刷新，
// 否则它自己的 11002 会再次触发 RefreshToken，形成递归请求风暴。
function isPublicAuthMethod(req: { method: { name: string; parent: { typeName: string } } }): boolean {
	return req.method.parent.typeName === UserService.typeName && PUBLIC_AUTH_METHODS.has(req.method.name);
}

// getClientOS 将 Obsidian 运行平台转换为服务端约定的操作系统标识。
export function getClientOS(): "ios" | "android" | "macos" | "windows" | "linux" | "unknown" {
	if (Platform.isIosApp) return "ios";
	if (Platform.isAndroidApp) return "android";
	if (Platform.isMacOS) return "macos";
	if (Platform.isWin) return "windows";
	if (Platform.isLinux) return "linux";
	return "unknown";
}

// createAuthInterceptor 单独导出便于验证刷新/重试状态机；不属于插件对外 API。
export function createAuthInterceptor(getConfig: () => RemoteConfig): Interceptor {
	const ACCESS_REFRESH_AHEAD_MS = 60_000;
	return (next) => async (req) => {
		let cfg = getConfig();
		req.header.set("Plugin-Version", cfg.pluginVersion);
		req.header.set("Client-Platform", "plugin");
		req.header.set("Client-OS", getClientOS());

		if (isPublicAuthMethod(req)) {
			req.header.delete("Authorization");
			return next(req);
		}

		let refreshAttempted = false;
		for (;;) {
			cfg = getConfig();
			if (
				!refreshAttempted &&
				cfg.accessExpiresAtMs > 0 &&
				Date.now() >= cfg.accessExpiresAtMs - ACCESS_REFRESH_AHEAD_MS
			) {
				refreshAttempted = true;
				await cfg.onUnauthenticated();
				// refresh 会替换 settings 中的 token；必须重新取快照，不能继续发送旧值。
				cfg = getConfig();
			}

			req.header.delete("Authorization");
			if (cfg.accessToken) {
				req.header.set("Authorization", `Bearer ${cfg.accessToken}`);
			}

			try {
				return await next(req);
			} catch (err) {
				// 未做过预刷新时，11002 可触发一次被动刷新；成功后用新配置重试原请求一次。
				if (
					!refreshAttempted &&
					errorCode(err) === ErrCode.InvalidOrMissingCredentials &&
					cfg.accessToken
				) {
					refreshAttempted = true;
					if (await cfg.onUnauthenticated()) {
						continue;
					}
				}
				throw err;
			}
		}
	};
}

export class RemoteClient {
	userClient: ReturnType<typeof createClient<typeof UserService>>;
	syncClient: ReturnType<typeof createClient<typeof SyncService>>;
	subscriptionClient: ReturnType<typeof createClient<typeof SubscriptionService>>;
	private getConfig: () => RemoteConfig;
	private currentBaseUrl = "";

	constructor(getConfig: () => RemoteConfig) {
		this.getConfig = getConfig;
		const transport = this.buildTransport("");
		this.userClient = createClient(UserService, transport);
		this.syncClient = createClient(SyncService, transport);
		this.subscriptionClient = createClient(SubscriptionService, transport);
	}

	// rebuild baseUrl 变更时重建 transport 与客户端（插件初始化时调用）
	rebuild(baseUrl: string): void {
		if (baseUrl === this.currentBaseUrl) {
			return;
		}
		const transport = this.buildTransport(baseUrl);
		this.userClient = createClient(UserService, transport);
		this.syncClient = createClient(SyncService, transport);
		this.subscriptionClient = createClient(SubscriptionService, transport);
		this.currentBaseUrl = baseUrl;
		debugLog.info("[pickpen] 远端地址已更新");
	}

	private buildTransport(baseUrl: string): Transport {
		const self = this;
		const loggingInterceptor: Interceptor = (next) => async (req) => {
			const start = performance.now();
			const method = `${req.method.parent.typeName}/${req.method.name}`;
			try {
				const res = await next(req);
				const cost = Math.round(performance.now() - start);
				debugLog.info(`[pickpen][请求] ${method} 成功（${cost}ms）`);
				return res;
			} catch (err) {
				const cost = Math.round(performance.now() - start);
				const e = err as { code?: number };
				debugLog.error(`[pickpen][请求] ${method} 失败（${cost}ms），错误码：${e.code ?? "unknown"}`);
				throw err;
			}
		};
		return createGrpcWebTransport({
			baseUrl,
			interceptors: [loggingInterceptor, createAuthInterceptor(self.getConfig)],
		});
	}
}

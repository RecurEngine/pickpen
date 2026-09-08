// 插件内部统一类型（Snapshot 同步 v2）：绑定主键 vault_id（name 仅展示），
// int64 一律十进制字符串。登录态：access_token（2h）+ refresh_token（30d，自动刷新）。

// PluginSettings 内存镜像。持久化拆分：
//  - vaultId/vaultName/extraExcludes/debugLog 落 data.json（会随 iCloud 同步 vault）；
//  - email/userId/token 族/deviceId 属登录会话，来源=设备本地 SessionStore（session-store.ts），
//    经 stripSessionKeys 剔除后不写 data.json（防止多端共享 data.json 造成 deviceId/token 互顶）。
// 同步内核/UI 一律读本内存镜像，来源切换对它们无感。
export interface PluginSettings {
	vaultId: string; // 远端绑定仓库 ID（十进制字符串；空 = 未绑定；name 仅展示）
	vaultName: string; // 绑定仓库名（仅展示用，换绑判断按 vault_id，spec §6.4）
	email: string; // 登录邮箱（会话域，设备本地；退出登录保留便于预填）
	userId: string; // 用户 ID（会话域，设备本地）
	accessToken: string; // access token（会话域；2 小时，过期自动用 refresh 换新）
	accessExpiresAtMs: number; // access token 过期时间戳
	refreshToken: string; // refresh token（会话域；30 天，一次性消费轮换）
	refreshExpiresAtMs: number; // refresh token 过期时间戳
	deviceId: string; // 设备唯一 ID（会话域，设备本地生成后不变；sync-base 归属校验 + 登录/刷新携带）
	// 绑定归属（vaultId + 绑定时账号邮箱）：随 data.json 跨端共享（不含密钥），
	// 供新设备登录同账号时自动沿用原绑定、以及跨账号守卫用
	vaultOwner?: { vaultId: string; email: string };
	extraExcludes: string[];
	debugLog: boolean; // 调试日志开关：开启后设置面板实时展示插件内部 console 输出
	// persist 落盘回调（index.ts 装配时注入 plugin.saveData，仅写 data.json 非会话键，不随 data.json 序列化）
	persist?: () => Promise<void>;
}

// 构建期由 esbuild define 注入（见 esbuild.config.mjs：PICKPEN_ENV → config/<env>.ts，
// PICKPEN_BASE_URL 支持环境变量覆盖，供本地联调指向自建后端）；
// 编译后为字符串字面量，运行时无 process 访问。?? 兜底仅静态分析路径。
// 为编译期常量，不随 data.json 持久化（设置面板只读展示）。
export const BASE_URL = process.env.PICKPEN_BASE_URL ?? "https://api.example.com/api";

// 移动端插件的官网收银台地址，与 API 域名独立；构建时可用 PICKPEN_CHECKOUT_URL 覆盖。
export const CHECKOUT_URL = process.env.PICKPEN_CHECKOUT_URL ?? "https://www.example.com/checkout";

// 本地 dev 构建标识：构建脚本注入 PICKPEN_BUILD_TAG；正式渠道构建为空 → 设置面板不显示标记
export const BUILD_TAG = process.env.PICKPEN_BUILD_TAG ?? "";

// local-hint 客户端默认防抖窗口：服务端未下发有效 local_debounce_ms 时使用；不落盘。
export const DEBOUNCE_MS = 10_000;

/** 服务端防抖值解析：正的安全整数覆盖默认值；0/负数/溢出均回退客户端默认。 */
export function resolveLocalDebounceMs(serverValue: bigint): number {
	if (serverValue <= 0n || serverValue > BigInt(Number.MAX_SAFE_INTEGER)) return DEBOUNCE_MS;
	return Number(serverValue);
}

export const DEFAULT_SETTINGS: PluginSettings = {
	vaultId: "",
	vaultName: "",
	email: "",
	userId: "",
	accessToken: "",
	accessExpiresAtMs: 0,
	refreshToken: "",
	refreshExpiresAtMs: 0,
	deviceId: "",
	extraExcludes: [],
	debugLog: false,
};

// VaultInfo 仓库信息（proto sync.VaultInfo 镜像：int64 → 十进制字符串）
export interface VaultInfo {
	vaultId: string;
	name: string;
	revision: string;
	rootHash: string;
}

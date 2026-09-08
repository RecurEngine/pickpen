// 邮箱验证码登录、token 存取（设备本地会话，见 session-store.ts）与自动刷新

import { LoginType, SendCodeType } from "./gen/proto/user/user.ext_pb";
import { debugLog } from "./debug-log";
import type { PluginSettings } from "./types";
import type { RemoteClient } from "./remote-connect";
import { ErrCode, errorCode } from "./remote-connect";

export class AuthManager {
	private settings: PluginSettings;
	private client: RemoteClient;
	// onSessionPersist：会话写入回调（index.ts 注入 = sessionStore.captureFrom(settings)，
	// 把镜像 token 族写进设备本地 localStorage；绝不写 data.json）
	private onSessionPersist: () => void;
	// refreshing 在途刷新 promise：并发请求共享同一个刷新（并发去重）
	private refreshing: Promise<boolean> | null = null;

	constructor(settings: PluginSettings, client: RemoteClient, onSessionPersist: () => void) {
		this.settings = settings;
		this.client = client;
		this.onSessionPersist = onSessionPersist;
	}

	// 内存镜像 accessToken 与会话权威同源（onload applyTo / 每次写后 captureFrom），进程内判定等价
	isLoggedIn(): boolean {
		return !!this.settings.accessToken;
	}

	// sendCode 发送登录验证码（服务端限流：邮箱、单 IP 与全局分别限量；触发返回 11004）
	async sendCode(email: string): Promise<void> {
		await this.client.userClient.sendCode({ type: SendCodeType.LOGIN, loginType: LoginType.EMAIL, email: email.trim() });
	}

	// login 邮箱验证码登录（登录即注册，服务端语义）；成功写双 token 落盘，失败抛错不写
	async login(email: string, code: string): Promise<void> {
		const resp = await this.client.userClient.login({
			loginType: LoginType.EMAIL,
			email: email.trim().toLowerCase(),
			code: code.trim(),
			deviceId: this.settings.deviceId,
		});
		this.settings.email = resp.email;
		this.settings.userId = String(resp.userId);
		this.settings.accessToken = resp.accessToken;
		this.settings.accessExpiresAtMs = Number(resp.accessExpiresAtMs);
		this.settings.refreshToken = resp.refreshToken;
		this.settings.refreshExpiresAtMs = Number(resp.refreshExpiresAtMs);
		this.onSessionPersist(); // 只写设备本地会话，不回写 data.json
		debugLog.info("[pickpen] 登录成功");
	}

	// refresh 用 refresh token 换新 token 对（并发去重；失败返回 false 不清登录态，
	// 由调用方决定是否重试/退出；refresh 失效时内部清空 token 并返回 false）
	refresh(): Promise<boolean> {
		if (this.refreshing) {
			return this.refreshing;
		}
		// doRefresh 会立即进入 transport interceptor；先通过 microtask 推迟它，确保
		// refreshing 已发布后才真正发起 RPC，阻断 RefreshToken 的同步重入窗口。
		const task = Promise.resolve().then(() => this.doRefresh());
		const tracked = task.finally(() => {
			if (this.refreshing === tracked) {
				this.refreshing = null;
			}
		});
		this.refreshing = tracked;
		return tracked;
	}

	private async doRefresh(): Promise<boolean> {
		if (!this.settings.refreshToken || !this.settings.userId) {
			return false;
		}
		try {
			const resp = await this.client.userClient.refreshToken({
				userId: BigInt(this.settings.userId),
				deviceId: this.settings.deviceId,
				refreshToken: this.settings.refreshToken,
			});
			this.settings.accessToken = resp.accessToken;
			this.settings.accessExpiresAtMs = Number(resp.accessExpiresAtMs);
			this.settings.refreshToken = resp.refreshToken;
			this.settings.refreshExpiresAtMs = Number(resp.refreshExpiresAtMs);
			this.onSessionPersist(); // 只写设备本地会话（refresh 一次性轮换必须落 localStorage 而非 data.json）
			debugLog.info("[pickpen] token 已自动刷新");
			return true;
		} catch (err) {
			// refresh token 失效（11002，如 30 天过期）→ 清空登录态落入未登录
			if (errorCode(err) === ErrCode.InvalidOrMissingCredentials) {
				debugLog.warn("[pickpen] refresh token 失效，已退出登录");
				await this.logout();
				return false;
			}
			// 网络类错误不视为失效，保持登录态由调用方按现状处理
			debugLog.warn(`[pickpen] token 刷新失败，错误码：${errorCode(err) ?? "unknown"}`);
			return false;
		}
	}

	// logout 清除本地登录态（设置面板退出登录）；保留 email 便于重登展示
	async logout(): Promise<void> {
		this.settings.accessToken = "";
		this.settings.accessExpiresAtMs = 0;
		this.settings.refreshToken = "";
		this.settings.refreshExpiresAtMs = 0;
		this.settings.userId = "";
		this.onSessionPersist(); // 清会话写设备本地；保留 email/deviceId（重登预填、base 不重建）
		debugLog.info("[pickpen] 已退出登录");
	}
}

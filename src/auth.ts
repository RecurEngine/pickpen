// 邮箱验证码登录、token 存取（设备本地会话，见 session-store.ts）与自动刷新

import { LoginType, SendCodeType } from "./gen/proto/user/user.ext_pb";
import { debugLog } from "./debug-log";
import type { PluginSettings } from "./types";
import type { SessionFields } from "./session-store";
import type { RemoteClient } from "./remote-connect";
import { ErrCode, errorCode } from "./remote-connect";

export class AuthManager {
	private settings: PluginSettings;
	private client: RemoteClient;
	// onSessionPersist：会话写入回调（index.ts 注入 = sessionStore.captureFrom(settings)，
	// 把镜像 token 族写进设备本地 localStorage；绝不写 data.json）
	private onSessionPersist: () => void;
	// onSessionLoad：会话读取回调（index.ts 注入 = sessionStore.snapshot()）。刷新失败时用它
	// 判断本机记录是否已被另一个实例轮换过（详见 doRefresh 的 11002 分支）。
	private onSessionLoad: () => SessionFields;
	// refreshing 在途刷新 promise：并发请求共享同一个刷新（并发去重）
	private refreshing: Promise<boolean> | null = null;
	// disposed：插件实例已被卸载。卸载不会中断在途 Promise，若不拦住，已停用的实例会继续
	// 轮换（并可能清空）与新实例共享的会话记录——这正是「重载插件后被登出」的成因。
	private disposed = false;

	constructor(
		settings: PluginSettings,
		client: RemoteClient,
		onSessionPersist: () => void,
		onSessionLoad: () => SessionFields,
	) {
		this.settings = settings;
		this.client = client;
		this.onSessionPersist = onSessionPersist;
		this.onSessionLoad = onSessionLoad;
	}

	/** 卸载时调用：此后不再发起刷新，也不再因刷新失败而清空会话（新实例已接管） */
	dispose(): void {
		this.disposed = true;
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
	// inviteCode 仅在该邮箱首次注册时被服务端采纳，已注册用户填写会被忽略
	async login(email: string, code: string, inviteCode = ""): Promise<void> {
		const resp = await this.client.userClient.login({
			loginType: LoginType.EMAIL,
			email: email.trim().toLowerCase(),
			code: code.trim(),
			deviceId: this.settings.deviceId,
			inviteCode: inviteCode.trim(),
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
		if (this.disposed) {
			return Promise.resolve(false);
		}
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
		if (this.disposed) return false;
		if (!this.settings.refreshToken || !this.settings.userId) {
			return false;
		}
		const presented = this.settings.refreshToken;
		let failure: unknown;
		try {
			await this.requestNewPair(presented);
			return true;
		} catch (err) {
			failure = err;
		}
		if (errorCode(failure) === ErrCode.InvalidOrMissingCredentials) {
			// 11002 有两种含义：这把 refresh token 已失效，或它只是被本机另一个实例轮换掉了
			// （插件重载窗口内新旧实例并存，两者共用同一 deviceId 的同一把轮换凭证）。
			// 后者可以自愈：本机记录里若已是另一把，说明失效的只是我手里这把，采用并重试一次。
			const stored = this.onSessionLoad();
			if (stored.refreshToken && stored.refreshToken !== presented && stored.userId === this.settings.userId) {
				debugLog.info("[pickpen] 本机会话已被其它实例轮换，改用最新 token 重试");
				this.settings.accessToken = stored.accessToken;
				this.settings.accessExpiresAtMs = stored.accessExpiresAtMs;
				this.settings.refreshToken = stored.refreshToken;
				this.settings.refreshExpiresAtMs = stored.refreshExpiresAtMs;
				try {
					await this.requestNewPair(stored.refreshToken);
					return true;
				} catch (retryErr) {
					failure = retryErr;
				}
			}
			// 提交的就是本机记录里那把、且仍被拒 → 会话确实失效，清空登录态落入未登录。
			// 已卸载的实例不参与判定：它无权清掉新实例正在使用的会话。
			if (errorCode(failure) === ErrCode.InvalidOrMissingCredentials && !this.disposed) {
				debugLog.warn("[pickpen] refresh token 失效，已退出登录");
				await this.logout();
				return false;
			}
		}
		// 网络类错误不视为失效，保持登录态由调用方按现状处理
		debugLog.warn(`[pickpen] token 刷新失败，错误码：${errorCode(failure) ?? "unknown"}`);
		return false;
	}

	// requestNewPair 用给定 refresh token 换新 token 对并落盘（成功即写内存镜像与设备本地会话）
	private async requestNewPair(refreshToken: string): Promise<void> {
		const resp = await this.client.userClient.refreshToken({
			userId: BigInt(this.settings.userId),
			deviceId: this.settings.deviceId,
			refreshToken,
		});
		this.settings.accessToken = resp.accessToken;
		this.settings.accessExpiresAtMs = Number(resp.accessExpiresAtMs);
		this.settings.refreshToken = resp.refreshToken;
		this.settings.refreshExpiresAtMs = Number(resp.refreshExpiresAtMs);
		this.onSessionPersist(); // 只写设备本地会话（refresh 一次性轮换必须落 localStorage 而非 data.json）
		debugLog.info("[pickpen] token 已自动刷新");
	}

	// logout 清除本地登录态（设置面板退出登录）；保留 email 便于重登展示。
	// 已卸载的实例直接返回：会话是与新实例共享的，旧实例无权清空它。
	async logout(): Promise<void> {
		if (this.disposed) return;
		this.settings.accessToken = "";
		this.settings.accessExpiresAtMs = 0;
		this.settings.refreshToken = "";
		this.settings.refreshExpiresAtMs = 0;
		this.settings.userId = "";
		this.onSessionPersist(); // 清会话写设备本地；保留 email/deviceId（重登预填、base 不重建）
		debugLog.info("[pickpen] 已退出登录");
	}
}

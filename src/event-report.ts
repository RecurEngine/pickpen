// 客户端事件上报：目前只用于「首次启用引导弹窗已展示」这一件事。
// 上报走旁路：不重试、不弹提示、不阻塞用户，失败只留一行调试日志。

import { debugLog } from "./debug-log";
import type { RemoteClient } from "./remote-connect";
import { errorCode } from "./remote-connect";
import type { SetupStage } from "./setup-guide";

/** 引导弹窗展示事件名（服务端按此名记录日志） */
export const SETUP_GUIDE_SHOWN_EVENT = "setup_guide_shown";

/** setupGuideEvent 事件载荷（纯函数）。插件版本、系统与平台随请求头发送，不重复放进事件体。 */
export function setupGuideEvent(stage: SetupStage): { event: string; stage: string } {
	return { event: SETUP_GUIDE_SHOWN_EVENT, stage };
}

/** reportSetupGuideShown 上报引导弹窗已展示：fire-and-forget，任何失败都不影响用户。 */
export function reportSetupGuideShown(client: RemoteClient, stage: SetupStage): void {
	void client.dataClient
		.reportEvent(setupGuideEvent(stage))
		.catch((err) => debugLog.warn(`[pickpen] 事件上报失败，错误码：${errorCode(err) ?? "unknown"}`));
}

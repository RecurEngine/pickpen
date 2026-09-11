import { describe, expect, it, vi } from "vitest";

import { reportSetupGuideShown, SETUP_GUIDE_SHOWN_EVENT, setupGuideEvent } from "../src/event-report";
import type { RemoteClient } from "../src/remote-connect";

function clientWithReport(reportEvent: (req: unknown) => Promise<unknown>): RemoteClient {
	return { dataClient: { reportEvent } } as unknown as RemoteClient;
}

describe("引导弹窗事件上报", () => {
	it("载荷只含事件名与阶段，不带任何标识信息", () => {
		expect(setupGuideEvent("login")).toEqual({ event: SETUP_GUIDE_SHOWN_EVENT, stage: "login" });
		expect(setupGuideEvent("bind")).toEqual({ event: "setup_guide_shown", stage: "bind" });
	});

	it("按当前阶段发起上报", async () => {
		const reportEvent = vi.fn(async () => ({}));

		reportSetupGuideShown(clientWithReport(reportEvent), "bind");

		expect(reportEvent).toHaveBeenCalledExactlyOnceWith({ event: SETUP_GUIDE_SHOWN_EVENT, stage: "bind" });
		await Promise.resolve(); // 让 fire-and-forget 的微任务落地
	});

	it("上报失败不抛出、不影响调用方", async () => {
		const reportEvent = vi.fn(async () => {
			throw new Error("network down");
		});

		expect(() => reportSetupGuideShown(clientWithReport(reportEvent), "login")).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0)); // catch 未生效会变成未处理的 rejection
		expect(reportEvent).toHaveBeenCalledOnce();
	});
});

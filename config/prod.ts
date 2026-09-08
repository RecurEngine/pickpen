// 生产环境：api.pickpen.net
import type { EnvConfig } from "./types";

const config: EnvConfig = {
	baseUrl: "https://api.pickpen.net/api",
	checkoutUrl: "https://www.pickpen.net/checkout",
	desktopPollIntervalMs: 20_000,
};

export default config;

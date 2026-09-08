// 测试环境：api.example.com
import type { EnvConfig } from "./types";

const config: EnvConfig = {
	baseUrl: "https://api.example.com/api",
	checkoutUrl: "https://www.example.com/checkout",
	desktopPollIntervalMs: 20_000,
};

export default config;

// 生产环境配置。
import type { EnvConfig } from "./types";

const config: EnvConfig = {
	baseUrl: "https://api.pickpen.net/api",
	desktopPollIntervalMs: 20_000,
};

export default config;

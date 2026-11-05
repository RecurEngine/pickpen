// 本地联调环境：本机 ENV=local 后端（h2c :8080，/api 前缀）
import type { EnvConfig } from "./types";

const config: EnvConfig = {
	baseUrl: "http://127.0.0.1:8080/api",
	desktopPollIntervalMs: 3_000,
};

export default config;

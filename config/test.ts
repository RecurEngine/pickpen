// 测试构建地址由构建环境显式提供，公开源码不包含部署地址。
import type { EnvConfig } from "./types";

function requireEnv(name: "PICKPEN_BASE_URL" | "PICKPEN_CHECKOUT_URL"): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`错误: 测试构建必须设置 ${name}`);
	return value;
}

const config: EnvConfig = {
	baseUrl: requireEnv("PICKPEN_BASE_URL"),
	checkoutUrl: requireEnv("PICKPEN_CHECKOUT_URL"),
	desktopPollIntervalMs: 20_000,
};

export default config;

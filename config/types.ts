// 环境配置接口（构建期使用）
// 这些文件只被 esbuild.config.mjs（node 侧）动态 import，不参与插件 bundle，
// 值经 esbuild define 注入为 process.env.PICKPEN_* 编译期常量，不会打进 main.js。
export interface EnvConfig {
	baseUrl: string; // 后端地址（必须以 /api 结尾）
	checkoutUrl: string; // 移动端官网收银台地址
	desktopPollIntervalMs: number; // 桌面端 Head 轮询间隔（local 缩短便于联调）
}

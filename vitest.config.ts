import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// node 环境补 window 垫片（源码统一用 window.setTimeout/window.clearTimeout）
		setupFiles: ["tests/window-shim.ts"],
		alias: {
			// obsidian 是纯类型包（无运行时导出），node 测试环境解析到 stub
			obsidian: resolve(__dirname, "tests/obsidian-stub.ts"),
		},
	},
});

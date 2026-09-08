import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		alias: {
			// obsidian 是纯类型包（无运行时导出），node 测试环境解析到 stub
			obsidian: resolve(__dirname, "tests/obsidian-stub.ts"),
		},
	},
});

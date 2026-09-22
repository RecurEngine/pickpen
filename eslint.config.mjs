// ESLint 配置：接入 Obsidian 官方规则集（含 typescript-eslint 类型检查规则），
// 用途是把社区插件审查的自动扫描结果在本地复现，避免提审后才发现问题。
// 规则清单与推荐用法见 eslint-plugin-obsidianmd 的 README。
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					// 不在 tsconfig include 内的构建侧文件，按默认项目单独解析
					allowDefaultProject: ["eslint.config.*", "vitest.config.ts", "esbuild.config.mjs", "config/*.ts"],
				},
			},
		},
	},
	{
		// 构建产物与协议生成代码不参与 lint（生成代码的风格由协议源保证）；
		// 测试跑在 node 环境、不随插件发布，其 mock 会大量触发类型检查规则，故不纳入。
		ignores: ["main.js", "src/gen/**", "node_modules/**", "coverage/**", "tests/**"],
	},
	{
		// 插件源码运行在 Obsidian 宿主内：未定义标识符由 tsc 保证，no-undef 只会误报
		// 构建期被 define 替换的 process.env.PICKPEN_*。
		files: ["src/**/*.ts"],
		rules: { "no-undef": "off" },
	},
	{
		// 构建脚本与构建期配置运行在 node 侧，补上 node 全局；
		// 这些文件不随插件发布、也不进插件运行时，node 模块与动态 import 限制不适用。
		files: ["esbuild.config.mjs", "vitest.config.ts", "config/**/*.ts"],
		languageOptions: { globals: { process: "readonly", console: "readonly", __dirname: "readonly" } },
		rules: { "obsidianmd/no-nodejs-modules": "off", "no-unsanitized/method": "off" },
	},
	{
		rules: {
			// 产品与宿主名保留官方大小写：默认句首大小写规则会把 Pickpen Sync 改成 Pickpen sync、
			// 把 Obsidian 改成 obsidian。
			"obsidianmd/ui/sentence-case": ["warn", { brands: ["Pickpen Sync", "Pickpen", "Obsidian"] }],
		},
	},
]);

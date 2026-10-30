// 设备本地 localStorage 探测：隐私模式/禁用站点存储时访问 getter 会抛错，
// 返回 null 让调用方降级为仅内存（本次运行可用、不跨重启）。
// 独立成文件供 SessionStore 与异常上报队列共用，避免从 index.ts 反向导入造成循环依赖。

import type { KeyValueStore } from "./session-store";

export function createLocalKV(): KeyValueStore | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

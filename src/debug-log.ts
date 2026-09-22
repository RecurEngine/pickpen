// 插件私有调试日志。仅显式调用本模块，不修改全局 console，也不收集 Obsidian
// 或其他插件的输出。默认只把 error 输出到控制台；用户开启调试日志后才记录并
// 输出 info/debug/warn，供设置页查看或由用户主动附加到反馈邮件。

export type DebugLevel = "log" | "info" | "warn" | "error" | "debug";

export interface DebugLogEntry {
	time: string; // HH:MM:SS.mmm
	level: DebugLevel;
	message: string;
}

export const DEBUG_LOG_LIMIT = 2000;

type Listener = (entry: DebugLogEntry) => void;

function pad(n: number, w = 2): string {
	return String(n).padStart(w, "0");
}

function formatValue(value: unknown): string {
	switch (typeof value) {
		case "string":
			return value;
		case "number":
		case "bigint":
		case "boolean":
			return String(value);
		case "symbol":
			return value.toString();
		case "function":
			return "[Function]";
		default:
			break;
	}
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (value instanceof Error) return `[${value.name}]`;
	// 只记录对象/数组的类型名，不序列化其中的敏感值
	return `[${value.constructor?.name ?? "Object"}]`;
}

class DebugLog {
	private entries: DebugLogEntry[] = [];
	private listeners = new Set<Listener>();
	private enabled = false;

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) this.clear();
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dump(): readonly DebugLogEntry[] {
		return this.entries;
	}

	clear(): void {
		this.entries = [];
	}

	log(...args: unknown[]): void {
		this.emit("log", args);
	}

	info(...args: unknown[]): void {
		this.emit("info", args);
	}

	warn(...args: unknown[]): void {
		this.emit("warn", args);
	}

	error(...args: unknown[]): void {
		this.emit("error", args);
	}

	debug(...args: unknown[]): void {
		this.emit("debug", args);
	}

	private emit(level: DebugLevel, args: unknown[]): void {
		const message = args.map(formatValue).join(" ");
		if (!message) return;

		// 开启后只写插件内日志视图（设置面板可查看/复制），不镜像到 console：
		// 真实错误无论开关都仍走 console.error，便于排查启动期问题。
		if (this.enabled) {
			this.append(level, message);
			if (level === "error") console.error(message);
			return;
		}

		if (level === "error") console.error(message);
	}

	private append(level: DebugLevel, message: string): void {
		const now = new Date();
		const entry: DebugLogEntry = {
			time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`,
			level,
			message,
		};
		this.entries.push(entry);
		if (this.entries.length > DEBUG_LOG_LIMIT) {
			this.entries.splice(0, this.entries.length - DEBUG_LOG_LIMIT);
		}
		this.listeners.forEach((listener) => listener(entry));
	}
}

export const debugLog = new DebugLog();

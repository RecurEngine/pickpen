// 错误归一化与上报判定：
// - 有确定恢复策略的错误（令牌失效、快照冲突、清单校验、容量上限等）不上报，避免噪声；
// - 其余错误提取 name/message/stack/code/http_status 供脱敏与指纹使用。
// 注意：禁止对任意对象 JSON.stringify，避免把设置或请求体带出去。

import type { ErrorPhase } from "./types";

/** 与服务端错误码语义一致；这些错误客户端有明确恢复路径，不属于「未知异常」。 */
const EXPECTED_CODES = new Set([
	11002, // 令牌失效
	11003, // 验证码错误/过期
	11004, // 验证码发送过于频繁
	12006, // 声明哈希被拒
	12015, // Snapshot 变更，退避重试
	12017, // 引用未上传内容
	12018, // 清单校验失败，强拉 Manifest 自愈
	12023, // file_id 身份冲突
	12025, // 存储空间已满
	12026, // 路径格式非法
]);

/** 预期中断/用户输入类错误名，不上报。 */
const EXPECTED_NAMES = new Set([
	"LocalChangedDuringUploadError",
	"AbortError",
	"WrongPasswordError",
	"PathUnencodableError",
]);

export interface NormalizedError {
	name: string;
	message: string;
	stack: string;
	code: number;
	httpStatus: number;
}

function numericField(value: unknown, key: string): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

/** 错误类型名；非 Error 对象只取构造器名，绝不序列化内容。 */
export function errorNameOf(err: unknown): string {
	if (err instanceof Error && err.name) return err.name;
	if (typeof err === "object" && err !== null) {
		const ctor = (err as { constructor?: { name?: string } }).constructor;
		if (ctor?.name) return ctor.name;
	}
	return "Error";
}

function extractHttpStatus(message: string): number {
	const match = /HTTP\s+(\d{3})/i.exec(message);
	return match ? Number(match[1]) : 0;
}

/** 归一化任意抛出值。字符串直接用；对象只取构造器名，不读取其字段（除 code/status/message/stack）。 */
export function normalizeError(err: unknown): NormalizedError {
	if (typeof err === "string") {
		return { name: "Error", message: err, stack: "", code: 0, httpStatus: extractHttpStatus(err) };
	}

	const name = errorNameOf(err);
	const message = typeof (err as { message?: unknown })?.message === "string"
		? String((err as { message: string }).message)
		: name;
	const stack = typeof (err as { stack?: unknown })?.stack === "string" ? String((err as { stack: string }).stack) : "";
	const code = numericField(err, "code") ?? 0;
	const status = numericField(err, "status");
	const httpStatus = status ?? extractHttpStatus(message);

	const cause = (err as { cause?: unknown })?.cause;
	let fullMessage = message;
	if (cause instanceof Error && cause.message && cause.message !== message) {
		fullMessage = `${message}（cause: ${cause.message}）`;
	}

	return { name, message: fullMessage, stack, code, httpStatus };
}

/** 是否属于有确定恢复策略/用户主动取消的错误。 */
export function isExpectedError(err: unknown): boolean {
	const code = numericField(err, "code");
	if (code !== undefined && EXPECTED_CODES.has(code)) return true;
	return EXPECTED_NAMES.has(errorNameOf(err));
}

/** 网络类错误：单独做更严格的采样，避免断网用户刷屏。 */
export function isNetworkPhase(phase: ErrorPhase, err: unknown): boolean {
	if (phase === "network" || phase === "transfer") return true;
	const name = errorNameOf(err);
	if (name === "DirectTransferUnavailableError") return true;
	if (name === "TypeError") {
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string" && /fetch|network|load failed|networkerror/i.test(message)) return true;
	}
	return numericField(err, "code") === 14; // gRPC UNAVAILABLE
}

/** gRPC Unimplemented（旧服务端未部署新 RPC）：本会话停止重试。 */
export function isUnimplemented(err: unknown): boolean {
	return numericField(err, "code") === 12;
}

// 内容直传/直下：地址由服务端按对象短时效签发，字节由本端直接与远端存储交互，
// 不再经过应用服务端。请求失败由调用方的既有重试语义恢复（见 remote.ts），
// 这里只负责单次请求的成败判定。
//
// 传输通道按平台分工：桌面端用 requestUrl（走原生 HTTP，不受 CORS 限制）；
// 移动端用 fetch——requestUrl 在移动端会把 ArrayBuffer 请求体逐字节转成数组再 base64
// 过原生桥（响应方向同样要 base64 解回来），大文件瞬时占用可达请求体体积的十倍以上，
// 因此内容字节在移动端一律不走 requestUrl（spec FR-13）。

import { Platform, requestUrl } from "obsidian";

/** 直连单请求超时（fetch 通道；requestUrl 不支持超时，桌面端保持既有行为） */
const DIRECT_TIMEOUT_MS = 10 * 60 * 1000;

/** 移动端直连失败时允许回退 requestUrl 的最大请求体：回退意味着走 base64 桥，
 *  只对足够小的请求体（放大后仍安全）网开一面；更大的直接判失败，不把端上推回崩溃路径 */
const MOBILE_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;

/** 移动端直连通道不可用（网络或安全策略拦截），且体积不允许回退。
 *  文案面向用户：会经同步状态与回执直接展示。 */
export class DirectTransferUnavailableError extends Error {
	constructor(detail = "") {
		super(
			detail
				? `${detail} 无法直连传输：当前网络或浏览器安全策略不允许，请在桌面端完成该文件的同步，或更换网络后重试`
				: "内容直连通道不可用：当前网络或浏览器安全策略不允许，请在桌面端同步",
		);
		this.name = "DirectTransferUnavailableError";
	}
}

/** 取字节数对应的精确 ArrayBuffer：Uint8Array 可能是更大 buffer 的视图（如 protobuf subarray），
 * 必须按 byteOffset/byteLength 截取，否则会把相邻数据一并上传。 */
export function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes.buffer as ArrayBuffer;
	}
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 直下：GET 直传地址，非 200 一律抛错（由调用方按既有失败语义恢复）。
 * sizeHint 为签发回包声明的内容字节数，仅用于判断移动端是否允许回退。 */
export async function httpGetBytes(url: string, sizeHint?: number): Promise<Uint8Array> {
	if (Platform.isMobile) return mobileGet(url, sizeHint);
	return requestGet(url);
}

/** 直传：PUT 直传地址，非 2xx 一律抛错（地址已锁定字节数，不符时由存储侧拒绝） */
export async function httpPutBytes(url: string, body: Uint8Array): Promise<void> {
	if (Platform.isMobile) return mobilePut(url, body);
	return requestPut(url, body);
}

/** 超时信号；环境不支持 AbortSignal.timeout 时退化为无超时（不阻断传输） */
function timeoutSignal(): AbortSignal | undefined {
	return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
		? AbortSignal.timeout(DIRECT_TIMEOUT_MS)
		: undefined;
}

/**
 * 移动端 GET。fetch 抛错只可能是网络层失败（不可达/被 CORS 拦截，浏览器不区分），
 * 此时体积已知且在阈值内才回退 requestUrl；超时（AbortError）不在此列，原样抛出避免重发。
 */
async function mobileGet(url: string, sizeHint?: number): Promise<Uint8Array> {
	let resp: Response;
	try {
		resp = await fetch(url, { method: "GET", credentials: "omit", signal: timeoutSignal() });
	} catch (err) {
		if (!(err instanceof TypeError)) throw err;
		if (sizeHint !== undefined && sizeHint <= MOBILE_FALLBACK_MAX_BYTES) {
			return requestGet(url);
		}
		throw new DirectTransferUnavailableError();
	}
	if (resp.status !== 200) {
		throw new Error(`直下失败（HTTP ${resp.status}）`);
	}
	return new Uint8Array(await resp.arrayBuffer());
}

/** 移动端 PUT。不设自定义头：Content-Length 由浏览器按 body 长度自动填写，与签发时
 *  声明的长度同源（body 传视图即可，fetch 只发送视图覆盖的区间）。 */
async function mobilePut(url: string, body: Uint8Array): Promise<void> {
	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "PUT",
			// TS6 泛型 cast：运行时是真实 ArrayBuffer 上的视图，fetch 只发送视图覆盖的区间
			body: body as Uint8Array<ArrayBuffer>,
			credentials: "omit",
			signal: timeoutSignal(),
		});
	} catch (err) {
		if (!(err instanceof TypeError)) throw err;
		if (body.byteLength <= MOBILE_FALLBACK_MAX_BYTES) {
			return requestPut(url, body);
		}
		throw new DirectTransferUnavailableError();
	}
	if (resp.status < 200 || resp.status >= 300) {
		throw new Error(`直传失败（HTTP ${resp.status}）`);
	}
}

/** requestUrl 通道：桌面端主路径，也是移动端小请求体的回退通道 */
async function requestGet(url: string): Promise<Uint8Array> {
	const resp = await requestUrl({ url, throw: false });
	if (resp.status !== 200) {
		throw new Error(`直下失败（HTTP ${resp.status}）`);
	}
	return new Uint8Array(resp.arrayBuffer);
}

async function requestPut(url: string, body: Uint8Array): Promise<void> {
	const resp = await requestUrl({
		url,
		method: "PUT",
		body: toExactArrayBuffer(body),
		throw: false,
	});
	if (resp.status < 200 || resp.status >= 300) {
		throw new Error(`直传失败（HTTP ${resp.status}）`);
	}
}

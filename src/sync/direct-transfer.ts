// 内容直传/直下：地址由服务端按对象短时效签发，字节由本端直接与远端存储交互，
// 不再经过应用服务端中转。请求失败由调用方的既有重试语义恢复（见 remote.ts），
// 这里只负责单次请求的成败判定。
//
// 使用 Obsidian requestUrl：走原生 HTTP（不受 CORS 限制，桌面/移动端一致）。
// 地址对插件是不透明字符串，不含任何存储侧布局信息。

import { requestUrl } from "obsidian";

/** 取字节数对应的精确 ArrayBuffer：Uint8Array 可能是更大 buffer 的视图（如 protobuf subarray），
 * 必须按 byteOffset/byteLength 截取，否则会把相邻数据一并上传。 */
export function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes.buffer as ArrayBuffer;
	}
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 直下：GET 直传地址，非 200 一律抛错（由调用方回退 RPC 链路） */
export async function httpGetBytes(url: string): Promise<Uint8Array> {
	const resp = await requestUrl({ url, throw: false });
	if (resp.status !== 200) {
		throw new Error(`直下失败（HTTP ${resp.status}）`);
	}
	return new Uint8Array(resp.arrayBuffer);
}

/** 直传：PUT 直传地址，非 2xx 一律抛错（地址已锁定字节数，不符时由存储侧拒绝） */
export async function httpPutBytes(url: string, body: Uint8Array): Promise<void> {
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

// 内容 SHA-256（WebCrypto，跨桌面/移动端，无 Node 依赖）
// 从 src/hash.ts 迁入；重构完成后删除原文件。

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
	const buf: Uint8Array = data instanceof Uint8Array ? data : new Uint8Array(data);
	// TS6 将 Uint8Array 泛型化为 Uint8Array<ArrayBufferLike>，digest 需要 <ArrayBuffer>；
	// 运行时始终是真实 ArrayBuffer，cast 安全
	const digest = await crypto.subtle.digest("SHA-256", buf as Uint8Array<ArrayBuffer>);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return hex;
}

export async function readAndHash(
	adapter: { readBinary(path: string): Promise<ArrayBuffer> },
	path: string,
): Promise<{ content: ArrayBuffer; hash: string }> {
	const content = await adapter.readBinary(path);
	return { content, hash: await sha256Hex(content) };
}

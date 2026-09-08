// 低层文件写辅助（从旧 engine.ts 迁入，全走 vault.adapter，无 Node fs）：
// 逐级建目录、二进制写盘、本地复制。

import { App } from "obsidian";

/** Uint8Array → ArrayBuffer（adapter.writeBinary 入参；复制一份避免视图偏移） */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	return copy.buffer;
}

/** 逐级创建父目录（移动端 adapter.mkdir 对嵌套目录不可靠） */
export async function ensureParentDirs(app: App, path: string): Promise<void> {
	const adapter = app.vault.adapter;
	const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	if (!parent) return;
	const parts = parent.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const dir = parts.slice(0, i).join("/");
		if (!(await adapter.exists(dir))) {
			await adapter.mkdir(dir);
		}
	}
}

/** 写盘（自动创建父目录） */
export async function writeLocalFile(app: App, path: string, content: Uint8Array): Promise<void> {
	await ensureParentDirs(app, path);
	await app.vault.adapter.writeBinary(path, toArrayBuffer(content));
}

/** 本地文件复制（冲突副本用；读二进制再写，避免依赖 rename 语义） */
export async function copyLocalFile(app: App, from: string, to: string): Promise<void> {
	const content = await app.vault.adapter.readBinary(from);
	await writeLocalFile(app, to, new Uint8Array(content));
}

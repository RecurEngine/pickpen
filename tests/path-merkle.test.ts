// v2 Merkle 的 TS/Go 共享向量：同一组 entries（token key + enc_path）必须得到同一 root。
// 该值由两端共享的协议测试向量固定校验（服务端与插件各跑一次）。
import { describe, expect, it } from "vitest";

import { buildTree, type Entry } from "../src/sync/merkle";

const V2_ROOT = "71718b40f496f566a0a98455f6a26b008a4dc5840ac70d54d844d3589113284a";

const entries: Record<string, Entry> = {
	a: { state: "active", kind: 2, enc_path: "enc-a" },
	"a/b.md": { state: "active", content_hash: "a".repeat(64), size: "1", enc_path: "enc-b" },
	"c.md": { state: "deleted", enc_path: "enc-c" },
};

describe("v2 Merkle", () => {
	it("与 Go 实现逐字节一致", async () => {
		expect(await buildTree(entries, true).rootHash).toBe(V2_ROOT);
	});

	it("v1 模式忽略 enc_path，root 与没有密文时相同", async () => {
		const plain: Record<string, Entry> = {
			a: { state: "active", kind: 2 },
			"a/b.md": { state: "active", content_hash: "a".repeat(64), size: "1" },
			"c.md": { state: "deleted" },
		};
		const withEnc = await buildTree(entries, false).rootHash;
		const withoutEnc = await buildTree(plain, false).rootHash;
		expect(withEnc).toBe(withoutEnc);
		expect(withEnc).not.toBe(V2_ROOT);
	});

	it("v2 条目缺少 enc_path 直接报错", async () => {
		await expect(
			buildTree({ "a.md": { state: "active", content_hash: "a".repeat(64), size: "1" } }, true).rootHash,
		).rejects.toThrow("v2 entry missing enc_path");
	});
});

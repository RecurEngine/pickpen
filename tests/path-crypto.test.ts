// 路径加密内核：token 确定性/层级隔离、enc_path 往返与分桶填充、token 校验、边界。
import { describe, expect, it } from "vitest";

import {
	canEncodePath,
	PathDecodeError,
	PathCrypto,
	PathUnencodableError,
	PATH_TOKEN_MAX_DEPTH,
} from "../src/crypto/path-crypto";

function key(fill: number): Uint8Array {
	const out = new Uint8Array(32);
	out.fill(fill);
	return out;
}

describe("路径 token", () => {
	it("同一路径同一密钥恒定，且每段固定 16 字符", async () => {
		const a = await PathCrypto.create(key(1));
		const b = await PathCrypto.create(key(1));
		const ea = await a.encode("日记/2026/10-29.md");
		const eb = await b.encode("日记/2026/10-29.md");
		expect(ea.key).toBe(eb.key);
		expect(ea.encPath).toBe(eb.encPath);
		const segs = ea.key.split("/");
		expect(segs).toHaveLength(3);
		for (const seg of segs) expect(seg).toMatch(/^[A-Za-z0-9_-]{16}$/);
	});

	it("同名文件在不同目录得到不同 token（父级上下文）", async () => {
		const c = await PathCrypto.create(key(2));
		const inA = await c.token("a/x.md");
		const inB = await c.token("b/x.md");
		expect(inA).not.toBe(inB);
		expect(inA.split("/")[1]).not.toBe(inB.split("/")[1]);
	});

	it("换内容密钥后 token 与 enc_path 都改变", async () => {
		const a = await PathCrypto.create(key(3));
		const b = await PathCrypto.create(key(4));
		const ea = await a.encode("a.md");
		const eb = await b.encode("a.md");
		expect(ea.key).not.toBe(eb.key);
		expect(ea.encPath).not.toBe(eb.encPath);
	});

	it("拒绝非 NFC、超长与超过 30 层的路径", async () => {
		const c = await PathCrypto.create(key(5));
		const nfd = "é.md"; // é 的分解形式
		expect(canEncodePath(nfd)).toBe(false);
		await expect(c.token(nfd)).rejects.toBeInstanceOf(PathUnencodableError);
		const tooDeep = Array.from({ length: PATH_TOKEN_MAX_DEPTH + 1 }, (_, i) => `d${i}`).join("/");
		expect(canEncodePath(tooDeep)).toBe(false);
		const maxDepth = Array.from({ length: PATH_TOKEN_MAX_DEPTH }, (_, i) => `d${i}`).join("/");
		expect(canEncodePath(maxDepth)).toBe(true);
		expect((await c.token(maxDepth)).length).toBeLessThanOrEqual(512);
	});

	it("解出路径后校验 token；错误密钥/篡改/交换都失败", async () => {
		const a = await PathCrypto.create(key(6));
		const b = await PathCrypto.create(key(7));
		const ea = await a.encode("目录/文件.md");
		expect(await a.openEntry(ea.key, ea.encPath)).toBe("目录/文件.md");
		await expect(b.openEntry(ea.key, ea.encPath)).rejects.toBeInstanceOf(PathDecodeError);
		const other = await a.encode("目录/另一个.md");
		await expect(a.openEntry(ea.key, other.encPath)).rejects.toBeInstanceOf(PathDecodeError);
		// 篡改密文尾部
		const tampered = ea.encPath.slice(0, -2) + (ea.encPath.endsWith("AA") ? "BB" : "AA");
		await expect(a.open(tampered)).rejects.toBeInstanceOf(PathDecodeError);
	});
});

describe("enc_path 分桶填充", () => {
	it("同一 32 字节桶内的不同长度路径得到相同密文长度", async () => {
		const c = await PathCrypto.create(key(8));
		const short = await c.seal("a");
		const long = await c.seal("a".repeat(28)); // 1 + 1 + 28 = 30 ≤ 32
		expect(short.length).toBe(long.length);
	});

	it("跨桶时长度才会变化", async () => {
		const c = await PathCrypto.create(key(9));
		const a = await c.seal("a".repeat(30)); // 31 → 32
		const b = await c.seal("a".repeat(32)); // 33 → 64
		expect(b.length).toBeGreaterThan(a.length);
	});

	it("往返还原 Unicode 路径", async () => {
		const c = await PathCrypto.create(key(10));
		const path = "日记/2026/10月/🌰 笔记.md";
		const enc = await c.seal(path);
		expect(await c.open(enc)).toBe(path);
	});
});

describe("enc_path 长度边界", () => {
	it("路径字节数落在 32 字节填充边界时不误判", async () => {
		const c = await PathCrypto.create(key(12));
		for (const n of [1, 30, 31, 32, 33, 63, 64, 65, 127, 128, 255, 256]) {
			const path = "a".repeat(n);
			const enc = await c.seal(path);
			expect(await c.open(enc)).toBe(path);
		}
	});

	it("长中文路径往返", async () => {
		const c = await PathCrypto.create(key(13));
		const path = "路径加密测试/中文目录/远端笔记.md";
		expect(await c.open(await c.seal(path))).toBe(path);
	});
});

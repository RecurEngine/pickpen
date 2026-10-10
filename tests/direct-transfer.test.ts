// 内容直传/直下单测：插件只走直连通道——取服务端签发的地址，直接与远端存储交互。
// 直连地址是不透明字符串，这里只断言「用服务端给的地址做了一次 PUT/GET」，
// 以及失败时不会退回到内容类 RPC（putBlob/getBlob）。
import { afterEach, describe, expect, it, vi } from "vitest";

// 直接引测试桩（与 vitest alias 的 "obsidian" 指向同一文件、同一模块实例），
// 便于类型层面拿到打桩函数；被测代码内的 "obsidian" 仍由 alias 解析到本桩
import { resetPlatform, setPlatform, setRequestUrlHandler, type RequestUrlParam } from "./obsidian-stub";
import type { RemoteClient } from "../src/remote-connect";
import { toExactArrayBuffer } from "../src/sync/direct-transfer";
import { SnapshotRemote } from "../src/sync/remote";

const BLOB_URL = "https://storage.example/blob?sig=1";
const PUT_URL = "https://storage.example/put?sig=2";

function headReply() {
	return {
		vaultId: 7n,
		revision: 1n,
		rootHash: "root",
		unchanged: false,
		syncIntervalMs: 0n,
		maxFileSizeBytes: 30n,
		localDebounceMs: 0n,
		encrypted: false,
		keyVersion: 0n,
	};
}

function setup() {
	const syncClient = {
		getVaultHead: vi.fn(async () => headReply()),
		getBlobURL: vi.fn(async () => ({ url: BLOB_URL, expiresAt: 0n, size: 3n })),
		prepareBlobUpload: vi.fn(async () => ({ existing: false, url: PUT_URL, expiresAt: 0n })),
		// 内容类旧 RPC：插件不应再调用，保留桩以便断言「未被调用」
		getBlob: vi.fn(),
		putBlob: vi.fn(),
	};
	const client = { syncClient } as unknown as RemoteClient;
	const remote = new SnapshotRemote(client, () => ({
		baseUrl: "http://example.invalid",
		accessToken: "token",
		vaultId: "7",
	}));
	return { remote, syncClient };
}

afterEach(() => {
	setRequestUrlHandler(null);
});

describe("直下（getBlob）", () => {
	it("用服务端下发的地址直取，不调用内容类 RPC", async () => {
		const { remote, syncClient } = setup();
		const requested: string[] = [];
		setRequestUrlHandler(async (param) => {
			requested.push(param.url);
			return { status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer };
		});

		const got = await remote.getBlob("a".repeat(64), 1n, "root");

		expect([...got]).toEqual([1, 2, 3]);
		expect(requested).toEqual([BLOB_URL]);
		expect(syncClient.getBlobURL).toHaveBeenCalledTimes(1);
		expect(syncClient.getBlob).not.toHaveBeenCalled();
	});

	it("历史通道参数原样透传给地址签发", async () => {
		const { remote, syncClient } = setup();
		setRequestUrlHandler(async () => ({ status: 200, arrayBuffer: new ArrayBuffer(0) }));

		await remote.getBlob("b".repeat(64), 0n, "", "11111111-2222-3333-4444-555555555555");

		expect(syncClient.getBlobURL).toHaveBeenCalledWith(
			expect.objectContaining({ historyFileId: "11111111-2222-3333-4444-555555555555" }),
		);
	});

	it("直取非 200 原样抛错，不退回到内容类 RPC", async () => {
		const { remote, syncClient } = setup();
		setRequestUrlHandler(async () => ({ status: 403 }));

		await expect(remote.getBlob("a".repeat(64), 1n, "root")).rejects.toThrow("直下失败（HTTP 403）");
		expect(syncClient.getBlob).not.toHaveBeenCalled();
	});

	it("鉴权类业务错误（12015/12021 等）原样抛出", async () => {
		const { remote, syncClient } = setup();
		syncClient.getBlobURL.mockRejectedValueOnce(
			Object.assign(new Error("快照已变化"), { code: 12015 }),
		);
		setRequestUrlHandler(async () => {
			throw new Error("不应发起直取");
		});

		await expect(remote.getBlob("a".repeat(64), 1n, "root")).rejects.toMatchObject({ code: 12015 });
		expect(syncClient.getBlob).not.toHaveBeenCalled();
	});
});

describe("直传（putBlob）", () => {
	it("取地址后 PUT 原样字节，不调用内容类 RPC", async () => {
		const { remote, syncClient } = setup();
		const puts: RequestUrlParam[] = [];
		setRequestUrlHandler(async (param) => {
			puts.push(param);
			return { status: 200 };
		});

		const content = new Uint8Array([5, 6, 7, 8]);
		await remote.putBlob("b".repeat(64), content);

		expect(puts).toHaveLength(1);
		expect(puts[0].url).toBe(PUT_URL);
		expect(puts[0].method).toBe("PUT");
		expect([...new Uint8Array(puts[0].body as ArrayBuffer)]).toEqual([5, 6, 7, 8]);
		expect(syncClient.prepareBlobUpload).toHaveBeenCalledWith(
			expect.objectContaining({ size: 4n }),
		);
		expect(syncClient.putBlob).not.toHaveBeenCalled();
	});

	it("服务端已有同 hash（existing）不发起 PUT", async () => {
		const { remote, syncClient } = setup();
		syncClient.prepareBlobUpload.mockResolvedValueOnce({
			existing: true,
			url: "",
			expiresAt: 0n,
		});
		setRequestUrlHandler(async () => {
			throw new Error("不应发起直传");
		});

		await remote.putBlob("b".repeat(64), new Uint8Array([1]));

		expect(syncClient.putBlob).not.toHaveBeenCalled();
	});

	it("直传非 2xx 原样抛错，不退回内容类 RPC", async () => {
		const { remote, syncClient } = setup();
		setRequestUrlHandler(async () => ({ status: 403 }));

		await expect(remote.putBlob("b".repeat(64), new Uint8Array([1]))).rejects.toThrow(
			"直传失败（HTTP 403）",
		);
		expect(syncClient.putBlob).not.toHaveBeenCalled();
	});

	it("地址签发返回业务错误（12019 超限）原样抛出", async () => {
		const { remote, syncClient } = setup();
		syncClient.prepareBlobUpload.mockRejectedValueOnce(
			Object.assign(new Error("超限"), { code: 12019 }),
		);

		await expect(remote.putBlob("b".repeat(64), new Uint8Array([1]))).rejects.toMatchObject({
			code: 12019,
		});
		expect(syncClient.putBlob).not.toHaveBeenCalled();
	});
});

describe("移动端 fetch 通道（内容字节不走 requestUrl 的 base64 桥）", () => {
	const MB = 1024 * 1024;
	afterEach(() => {
		vi.unstubAllGlobals();
		resetPlatform();
	});

	it("直下走 fetch，不经 requestUrl", async () => {
		const { remote } = setup();
		setPlatform({ isMobile: true });
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(url);
			return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		});
		setRequestUrlHandler(async () => {
			throw new Error("不应走 requestUrl");
		});

		const got = await remote.getBlob("a".repeat(64), 1n, "root");

		expect([...got]).toEqual([1, 2, 3]);
		expect(urls).toEqual([BLOB_URL]);
	});

	it("直传走 fetch：PUT 原样字节、不改方法、不设自定义头", async () => {
		const { remote } = setup();
		setPlatform({ isMobile: true });
		const puts: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			puts.push({ url, init });
			return new Response(null, { status: 200 });
		});
		setRequestUrlHandler(async () => {
			throw new Error("不应走 requestUrl");
		});

		const content = new Uint8Array([5, 6, 7, 8]);
		await remote.putBlob("b".repeat(64), content);

		expect(puts).toHaveLength(1);
		expect(puts[0].url).toBe(PUT_URL);
		expect(puts[0].init.method).toBe("PUT");
		expect(puts[0].init.headers).toBeUndefined();
		expect([...new Uint8Array(puts[0].init.body as Uint8Array)]).toEqual([5, 6, 7, 8]);
	});

	it("直传非 2xx 抛错，不退回 requestUrl", async () => {
		const { remote } = setup();
		setPlatform({ isMobile: true });
		vi.stubGlobal("fetch", async () => new Response(null, { status: 403 }));
		const requestUrls: string[] = [];
		setRequestUrlHandler(async (param) => {
			requestUrls.push(param.url);
			return { status: 200 };
		});

		await expect(remote.putBlob("b".repeat(64), new Uint8Array([1]))).rejects.toThrow(
			"直传失败（HTTP 403）",
		);
		expect(requestUrls).toEqual([]);
	});

	it("网络失败且请求体很小 → 回退 requestUrl", async () => {
		const { remote } = setup();
		setPlatform({ isMobile: true });
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("Failed to fetch");
		});
		const requestUrls: string[] = [];
		setRequestUrlHandler(async (param) => {
			requestUrls.push(param.url);
			return { status: 200 };
		});

		await remote.putBlob("b".repeat(64), new Uint8Array([1, 2]));

		expect(requestUrls).toEqual([PUT_URL]);
	});

	it("网络失败且请求体超过回退阈值 → 明确失败并提示桌面端，不回退", async () => {
		const { remote } = setup();
		setPlatform({ isMobile: true });
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("Failed to fetch");
		});
		const requestUrls: string[] = [];
		setRequestUrlHandler(async (param) => {
			requestUrls.push(param.url);
			return { status: 200 };
		});

		const big = new Uint8Array(2 * MB + 1);
		await expect(remote.putBlob("b".repeat(64), big)).rejects.toThrow(/桌面端/);
		expect(requestUrls).toEqual([]);
	});

	it("直下体积超过回退阈值时同样不回退", async () => {
		const { remote, syncClient } = setup();
		setPlatform({ isMobile: true });
		syncClient.getBlobURL.mockResolvedValueOnce({ url: BLOB_URL, expiresAt: 0n, size: BigInt(2 * MB + 1) });
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("Failed to fetch");
		});
		const requestUrls: string[] = [];
		setRequestUrlHandler(async (param) => {
			requestUrls.push(param.url);
			return { status: 200 };
		});

		await expect(remote.getBlob("a".repeat(64), 1n, "root")).rejects.toThrow(/桌面端/);
		expect(requestUrls).toEqual([]);
	});

	it("超时（非 TypeError）原样抛出，不重发", async () => {
		const { remote } = setup();
		setPlatform({ isMobile: true });
		vi.stubGlobal("fetch", async () => {
			throw Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
		});
		const requestUrls: string[] = [];
		setRequestUrlHandler(async (param) => {
			requestUrls.push(param.url);
			return { status: 200 };
		});

		await expect(remote.putBlob("b".repeat(64), new Uint8Array([1]))).rejects.toThrow(
			"signal timed out",
		);
		expect(requestUrls).toEqual([]);
	});
});

describe("toExactArrayBuffer", () => {
	it("视图只截取自身区间，不夹带相邻数据", () => {
		const buf = new Uint8Array([1, 2, 3, 4, 5, 6]);
		const view = buf.subarray(2, 5);
		const exact = new Uint8Array(toExactArrayBuffer(view));
		expect([...exact]).toEqual([3, 4, 5]);
	});

	it("完整视图直接复用底层 buffer（不复制）", () => {
		const buf = new Uint8Array([7, 8]);
		expect(toExactArrayBuffer(buf)).toBe(buf.buffer);
	});
});

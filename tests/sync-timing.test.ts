import { describe, expect, it, vi } from "vitest";

import type { RemoteClient } from "../src/remote-connect";
import { SnapshotRemote } from "../src/sync/remote";
import { DEBOUNCE_MS, resolveLocalDebounceMs } from "../src/types";

describe("服务端本地防抖配置", () => {
	it("正的安全整数覆盖客户端默认值", () => {
		expect(resolveLocalDebounceMs(25_000n)).toBe(25_000);
	});

	it("0、负数和不安全整数回退客户端默认值", () => {
		expect(resolveLocalDebounceMs(0n)).toBe(DEBOUNCE_MS);
		expect(resolveLocalDebounceMs(-1n)).toBe(DEBOUNCE_MS);
		expect(resolveLocalDebounceMs(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe(DEBOUNCE_MS);
	});

	it("getHead 和 pollHead 都发布服务端防抖值", async () => {
		const getVaultHead = vi.fn(async () => ({
			revision: 3n,
			rootHash: "root",
			unchanged: true,
			syncIntervalMs: 20_000n,
			maxFileSizeBytes: 30n * 1024n * 1024n,
			localDebounceMs: 25_000n,
		}));
		const client = { syncClient: { getVaultHead } } as unknown as RemoteClient;
		const onHead = vi.fn();
		const remote = new SnapshotRemote(
			client,
			() => ({ baseUrl: "http://localhost", accessToken: "token", vaultId: "1" }),
			onHead,
		);

		await remote.getHead();
		await remote.pollHead(3n, "root");

		expect(onHead).toHaveBeenCalledTimes(2);
		expect(onHead).toHaveBeenLastCalledWith(expect.objectContaining({ localDebounceMs: 25_000n }));
	});
});

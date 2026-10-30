// Manifest 解码的路径键安全：路径是用户可控字符串，必须按自有属性处理，
// 不能被 Object.prototype（constructor/toString…）或 __proto__ setter 干扰。
import { describe, expect, it } from "vitest";

import { decodeManifestEntries } from "../src/sync/path-codec";
import type { Entry } from "../src/sync/types";

describe("manifest 路径键", () => {
	it("constructor / toString / __proto__ 都是合法文件名", async () => {
		const raw = JSON.parse(
			'{"constructor":{"state":"deleted"},"toString":{"state":"deleted"},"__proto__":{"state":"deleted"}}',
		) as Record<string, Entry>;
		const { entries } = await decodeManifestEntries(raw, 0);
		expect(Object.getPrototypeOf(entries)).toBe(null);
		for (const path of ["constructor", "toString", "__proto__"]) {
			expect(Object.hasOwn(entries, path)).toBe(true);
			expect(entries[path]?.state).toBe("deleted");
		}
	});
});

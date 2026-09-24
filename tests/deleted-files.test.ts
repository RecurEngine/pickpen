// 已删除文件的内容定位（specs/sync/spec.md 需求 3）：从 file_id 的历史版本里挑出删除事件那一版。
// 关键回归：同一路径「删除 → 重建 → 再改」时，直接取最新版本会预览到错内容。
import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { pickDeletedVersion } from "../src/deleted-files-view";
import { FileVersionInfoSchema, FileVersionState } from "../src/gen/proto/sync/sync.ext_pb";

function version(args: {
	revision: bigint;
	createdAt: bigint;
	state?: FileVersionState;
	contentHash?: string;
}): ReturnType<typeof create<typeof FileVersionInfoSchema>> {
	return create(FileVersionInfoSchema, {
		fileId: "00000000-0000-4000-8000-000000000001",
		path: "a.md",
		revision: args.revision,
		state: args.state ?? FileVersionState.FILE_VERSION_ACTIVE,
		contentHash: args.contentHash ?? "h",
		size: 1n,
		createdAt: args.createdAt,
	});
}

describe("pickDeletedVersion", () => {
	it("精确命中 (revision, deletedAt)", () => {
		const target = version({ revision: 7n, createdAt: 200n, state: FileVersionState.FILE_VERSION_DELETED });
		const versions = [version({ revision: 9n, createdAt: 400n }), target, version({ revision: 3n, createdAt: 100n })];
		expect(pickDeletedVersion(versions, 7n, 200n)).toBe(target);
	});

	it("删除 → 重建 → 再改：不取最新版本，取删除事件那一版", () => {
		const deleted = version({ revision: 5n, createdAt: 300n, state: FileVersionState.FILE_VERSION_DELETED });
		const versions = [
			version({ revision: 8n, createdAt: 500n }), // 重建后的最新内容（晚于删除）
			version({ revision: 6n, createdAt: 400n }), // 重建时的内容
			deleted,
			version({ revision: 2n, createdAt: 100n }),
		];
		const picked = pickDeletedVersion(versions, 5n, 300n);
		expect(picked).toBe(deleted);
		expect(picked?.contentHash).toBe("h");
	});

	it("无精确匹配时取不晚于删除时刻的最新一条", () => {
		const near = version({ revision: 4n, createdAt: 250n });
		const versions = [version({ revision: 9n, createdAt: 900n }), near, version({ revision: 1n, createdAt: 10n })];
		expect(pickDeletedVersion(versions, 5n, 300n)).toBe(near);
	});

	it("全部版本都晚于删除时刻时回退到最旧一条（保留期边界）", () => {
		const oldest = version({ revision: 1n, createdAt: 800n });
		const versions = [version({ revision: 3n, createdAt: 900n }), oldest];
		expect(pickDeletedVersion(versions, 2n, 100n)).toBe(oldest);
	});

	it("空列表返回 null", () => {
		expect(pickDeletedVersion([], 1n, 1n)).toBeNull();
	});
});

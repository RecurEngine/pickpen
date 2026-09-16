// 仓库端到端加密内核：确定性、往返、错口令与篡改检测，以及同步链路的加解密封装。
import { describe, expect, it } from "vitest";

import {
	BLOB_OVERHEAD_BYTES,
	createVaultKey,
	hexToBytes,
	isEncryptedBlob,
	openBlob,
	sealBlob,
	unwrapDek,
	WrongPasswordError,
	wrapDekWithPassword,
} from "../src/crypto/vault-crypto";
import { sealForRemote, openForLocal, vaultKeys } from "../src/crypto/vault-key-store";
import type { KeyValueStore } from "../src/session-store";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function memoryKV(): KeyValueStore {
	const map = new Map<string, string>();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
		removeItem: (k) => void map.delete(k),
	};
}

const PASSWORD = "correct horse battery staple";

describe("blob 加解密", () => {
	it("往返还原（含空内容与 1MB 二进制）", async () => {
		const { dek } = await createVaultKey(PASSWORD);
		const bigBinary = new Uint8Array(1024 * 1024);
		for (let i = 0; i < bigBinary.length; i++) bigBinary[i] = i % 251; // 含 0 字节的二进制附件
		const samples = [
			new Uint8Array(0),
			encoder.encode("a"),
			encoder.encode("# 标题\n\n中文笔记内容"),
			bigBinary,
		];
		for (const plain of samples) {
			const sealed = await sealBlob(dek, plain);
			expect(sealed.length).toBe(plain.length + BLOB_OVERHEAD_BYTES);
			expect(Array.from(await openBlob(dek, sealed))).toEqual(Array.from(plain));
		}
	});

	it("确定性：同一明文同一密钥始终得到同一密文（去重与快路径的前提）", async () => {
		const { dek } = await createVaultKey(PASSWORD);
		const plain = encoder.encode("重复同步的同一份内容");
		const first = await sealBlob(dek, plain);
		const second = await sealBlob(dek, new Uint8Array(plain));
		expect(Array.from(second)).toEqual(Array.from(first));
	});

	it("不同明文 / 不同仓库密钥得到不同密文", async () => {
		const a = await createVaultKey(PASSWORD);
		const b = await createVaultKey(PASSWORD);
		const sealedA = await sealBlob(a.dek, encoder.encode("x"));
		expect(Array.from(await sealBlob(a.dek, encoder.encode("y")))).not.toEqual(Array.from(sealedA));
		expect(Array.from(await sealBlob(b.dek, encoder.encode("x")))).not.toEqual(Array.from(sealedA));
	});

	it("密文自描述：明文不带头部标记，密文带头部标记", async () => {
		const { dek } = await createVaultKey(PASSWORD);
		expect(isEncryptedBlob(encoder.encode("普通笔记"))).toBe(false);
		expect(isEncryptedBlob(await sealBlob(dek, encoder.encode("普通笔记")))).toBe(true);
		expect(isEncryptedBlob(new Uint8Array([0xe1, 0x01]))).toBe(false); // 头部不全
	});

	it("密文被篡改时认证失败，不返回错误内容", async () => {
		const { dek } = await createVaultKey(PASSWORD);
		const sealed = await sealBlob(dek, encoder.encode("原始内容"));
		const tampered = new Uint8Array(sealed);
		tampered[tampered.length - 1] ^= 0x01;
		await expect(openBlob(dek, tampered)).rejects.toThrow();
	});

	it("换一个仓库密钥无法解密（密钥不匹配不会静默出错）", async () => {
		const a = await createVaultKey(PASSWORD);
		const b = await createVaultKey(PASSWORD);
		const sealed = await sealBlob(a.dek, encoder.encode("内容"));
		await expect(openBlob(b.dek, sealed)).rejects.toThrow();
	});
});

describe("仓库密钥包装", () => {
	it("口令正确时解出同一内容密钥", async () => {
		const { params, dek } = await createVaultKey(PASSWORD);
		expect(Array.from(await unwrapDek(PASSWORD, params))).toEqual(Array.from(dek));
	});

	it("口令错误抛 WrongPasswordError", async () => {
		const { params } = await createVaultKey(PASSWORD);
		await expect(unwrapDek("wrong password", params)).rejects.toBeInstanceOf(WrongPasswordError);
	});

	it("改密码只重新包装内容密钥，旧密文不需重加密", async () => {
		const { params, dek } = await createVaultKey(PASSWORD);
		const sealed = await sealBlob(dek, encoder.encode("改密码前的内容"));

		const rotated = await wrapDekWithPassword(dek, "new password");
		await expect(unwrapDek(PASSWORD, rotated)).rejects.toBeInstanceOf(WrongPasswordError);

		const recovered = await unwrapDek("new password", rotated);
		expect(Array.from(recovered)).toEqual(Array.from(dek));
		expect(decoder.decode(await openBlob(recovered, sealed))).toBe("改密码前的内容");
	});

	it("每次包装用新盐与新 nonce", async () => {
		const { dek } = await createVaultKey(PASSWORD);
		const first = await wrapDekWithPassword(dek, PASSWORD);
		const second = await wrapDekWithPassword(dek, PASSWORD);
		expect(first.kdfSalt).not.toBe(second.kdfSalt);
		expect(first.wrapNonce).not.toBe(second.wrapNonce);
		expect(first.wrappedKey).not.toBe(second.wrappedKey);
	});

	it("参数约定的长度：盐 32 hex、nonce 24 hex、包装密钥 96 hex", async () => {
		const { params } = await createVaultKey(PASSWORD);
		expect(params.kdfSalt).toHaveLength(32);
		expect(params.wrapNonce).toHaveLength(24);
		expect(params.wrappedKey).toHaveLength(96);
		expect(params.kdfIterations).toBeGreaterThan(0);
		expect(hexToBytes(params.kdfSalt)).toHaveLength(16);
	});
});

describe("同步链路封装的仓库状态", () => {
	it("未加密仓库：寻址哈希与改造前一致（明文 SHA-256），内容原样通过", async () => {
		vaultKeys.reset();
		const plain = encoder.encode("未加密仓库的笔记");
		const sealed = await sealForRemote(plain);
		expect(sealed.size).toBe(plain.byteLength);
		expect(Array.from(sealed.bytes)).toEqual(Array.from(plain));
		expect(Array.from(await openForLocal(sealed.bytes))).toEqual(Array.from(plain));
		expect(vaultKeys.isLocked()).toBe(false);
	});

	it("加密仓库：寻址哈希为密文哈希，下载内容自动解密", async () => {
		vaultKeys.reset();
		vaultKeys.configure(memoryKV(), "test-scope");
		const { params, dek } = await createVaultKey(PASSWORD);
		vaultKeys.syncRemote({ vaultId: "7", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("7", params);
		expect(vaultKeys.isLocked()).toBe(true);

		const plain = encoder.encode("加密仓库的笔记");
		await expect(sealForRemote(plain)).rejects.toThrow(); // 未解锁不得静默按明文上传

		await vaultKeys.unlock(PASSWORD);
		const sealed = await sealForRemote(plain);
		expect(sealed.size).toBe(plain.byteLength + BLOB_OVERHEAD_BYTES);
		expect(isEncryptedBlob(sealed.bytes)).toBe(true);
		// 确定性：同一明文重复加密得到同一寻址哈希（否则每次同步都会判成内容变化）
		expect((await sealForRemote(plain)).hash).toBe(sealed.hash);
		expect(Array.from(await openForLocal(sealed.bytes))).toEqual(Array.from(plain));

		// 加密仓库里转换前遗留的明文历史版本仍按明文读取
		expect(Array.from(await openForLocal(plain))).toEqual(Array.from(plain));
		expect(Array.from(await unwrapDek(PASSWORD, params))).toEqual(Array.from(dek));
	});

	it("密钥版本变化（别处改密码/转换）会重新上锁并要求重建基线", async () => {
		vaultKeys.reset();
		vaultKeys.configure(memoryKV(), "test-scope-2");
		const { params } = await createVaultKey(PASSWORD);
		vaultKeys.syncRemote({ vaultId: "9", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("9", params);
		await vaultKeys.unlock(PASSWORD);
		expect(vaultKeys.isLocked()).toBe(false);

		expect(vaultKeys.syncRemote({ vaultId: "9", encrypted: true, keyVersion: "2" })).toBe(true);
		expect(vaultKeys.isLocked()).toBe(true);
		// 密钥变化后旧参数已作废，必须重新取仓库元数据
		expect(vaultKeys.syncRemote({ vaultId: "9", encrypted: true, keyVersion: "2" })).toBe(false);
	});

	it("启动后首次拿到仓库状态不算密钥变更（否则每次启动都会全量重算内容哈希）", () => {
		vaultKeys.reset();
		vaultKeys.configure(memoryKV(), "test-scope-first");
		// 已加密仓库的首次观察：基线仍然有效，不得要求重建
		expect(vaultKeys.syncRemote({ vaultId: "31", encrypted: true, keyVersion: "1" })).toBe(false);
		expect(vaultKeys.isLocked()).toBe(true); // 但确实需要解锁
		// 未加密仓库的首次观察同样不触发重建
		vaultKeys.reset();
		expect(vaultKeys.syncRemote({ vaultId: "32", encrypted: false, keyVersion: "0" })).toBe(false);
		vaultKeys.reset();
	});

	it("运行中发生的转换/改密码/换仓库必须重建基线", () => {
		vaultKeys.reset();
		vaultKeys.configure(memoryKV(), "test-scope-transition");
		vaultKeys.syncRemote({ vaultId: "41", encrypted: false, keyVersion: "0" });
		// 明文 → 加密（转换）：寻址口径变了
		expect(vaultKeys.syncRemote({ vaultId: "41", encrypted: true, keyVersion: "1" })).toBe(true);
		// 换绑到另一个仓库
		expect(vaultKeys.syncRemote({ vaultId: "42", encrypted: false, keyVersion: "0" })).toBe(true);
		vaultKeys.reset();
	});

	it("在本设备记住：写入设备本地存储并可跨进程恢复；密钥版本不符则失效", async () => {
		const kv = memoryKV();
		vaultKeys.reset();
		vaultKeys.configure(kv, "test-scope-3");
		const { params } = await createVaultKey(PASSWORD);
		vaultKeys.syncRemote({ vaultId: "11", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("11", params);
		vaultKeys.setRemember(true);
		await vaultKeys.unlock(PASSWORD);

		// 模拟重开插件：内存清空后从本地存储恢复
		vaultKeys.lock();
		expect(vaultKeys.isLocked()).toBe(true);
		expect(await vaultKeys.tryRestoreRemembered()).toBe(true);
		expect(vaultKeys.isLocked()).toBe(false);

		// 别处改了密码 → 密钥版本不符，记忆作废
		vaultKeys.syncRemote({ vaultId: "11", encrypted: true, keyVersion: "2" });
		expect(await vaultKeys.tryRestoreRemembered()).toBe(false);

		// 关闭记忆后本地存储被清除
		vaultKeys.setRemember(false);
		expect(kv.getItem("pickpen:vaultkey:v1:test-scope-3")).toBeNull();
		vaultKeys.reset();
	});

	it("寻址代次：同密钥恒定、换密钥必变、未加密/未解锁为空——它是判断要不要重算全部哈希的唯一依据", async () => {
		vaultKeys.reset();
		vaultKeys.configure(memoryKV(), "test-scope-epoch");
		expect(vaultKeys.getEpoch()).toBe(""); // 未加密/未解锁

		const a = await createVaultKey(PASSWORD);
		const b = await createVaultKey(PASSWORD);
		vaultKeys.syncRemote({ vaultId: "61", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("61", a.params);
		await vaultKeys.unlock(PASSWORD);
		const epoch = vaultKeys.getEpoch();
		expect(epoch).toMatch(/^[0-9a-f]{32}$/);

		// 改密码只换信封：内容密钥没变 → 代次不变 → 不该触发整库重算
		vaultKeys.setParams("61", await wrapDekWithPassword(a.dek, "new password"));
		await vaultKeys.unlock("new password");
		expect(vaultKeys.getEpoch()).toBe(epoch);

		// 换内容密钥（别处转换/新建）→ 代次必变 → 必须重算
		vaultKeys.reset();
		vaultKeys.configure(memoryKV(), "test-scope-epoch");
		vaultKeys.syncRemote({ vaultId: "62", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("62", b.params);
		await vaultKeys.unlock(PASSWORD);
		expect(vaultKeys.getEpoch()).not.toBe(epoch);

		vaultKeys.lock();
		expect(vaultKeys.getEpoch()).toBe(""); // 上锁后无从判断，交由解锁后重新比较
		vaultKeys.reset();
	});

	it("记忆里的内容密钥形状不合法时拒绝使用（坏数据不能被当成密钥静默加密）", async () => {
		const kv = memoryKV();
		vaultKeys.reset();
		vaultKeys.configure(kv, "test-scope-badkey");
		const { params } = await createVaultKey(PASSWORD);
		vaultKeys.syncRemote({ vaultId: "71", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("71", params);
		// 截断的密钥：直接用会以错误密钥加密上传，换设备后才发现全部解不开
		kv.setItem("pickpen:vaultkey:v1:test-scope-badkey", JSON.stringify({
			schema: 1, vaultId: "71", keyVersion: "1", dek: "00ff",
		}));
		expect(await vaultKeys.tryRestoreRemembered()).toBe(false);
		expect(vaultKeys.isLocked()).toBe(true);
		expect(kv.getItem("pickpen:vaultkey:v1:test-scope-badkey")).toBeNull(); // 坏记录被清掉
		vaultKeys.reset();
	});

	it("密钥版本变化后本机记忆必然失效：必须重新输入密码", async () => {
		const kv = memoryKV();
		vaultKeys.reset();
		vaultKeys.configure(kv, "test-scope-4");
		const { params } = await createVaultKey(PASSWORD);
		vaultKeys.syncRemote({ vaultId: "51", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("51", params);
		vaultKeys.setRemember(true);
		await vaultKeys.unlock(PASSWORD);
		expect(kv.getItem("pickpen:vaultkey:v1:test-scope-4")).not.toBeNull();

		// 别处改了密码：版本迁移 → 本机记忆被清除，且不可能自动解锁（自动弹窗的前提）
		expect(vaultKeys.syncRemote({ vaultId: "51", encrypted: true, keyVersion: "2" })).toBe(true);
		expect(vaultKeys.isLocked()).toBe(true);
		expect(kv.getItem("pickpen:vaultkey:v1:test-scope-4")).toBeNull();
		expect(await vaultKeys.tryRestoreRemembered()).toBe(false);
		vaultKeys.reset();
	});

	it("「记住」偏好默认开启且跨重启保留：关掉后重启仍是关，解锁也不再写密钥记录", async () => {
		const kv = memoryKV();
		vaultKeys.reset();
		vaultKeys.configure(kv, "test-scope-pref");
		expect(vaultKeys.remember).toBe(true); // 首次使用（无偏好记录）：默认打开

		const { params } = await createVaultKey(PASSWORD);
		vaultKeys.syncRemote({ vaultId: "81", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("81", params);
		vaultKeys.setRemember(false); // 用户主动关闭
		expect(kv.getItem("pickpen:vaultpref:v1:test-scope-pref")).not.toBeNull();

		// 模拟重开插件：偏好仍是关，解锁不会在本机留下密钥
		vaultKeys.reset();
		vaultKeys.configure(kv, "test-scope-pref");
		expect(vaultKeys.remember).toBe(false);
		vaultKeys.syncRemote({ vaultId: "81", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("81", params);
		await vaultKeys.unlock(PASSWORD);
		expect(vaultKeys.isLocked()).toBe(false);
		expect(kv.getItem("pickpen:vaultkey:v1:test-scope-pref")).toBeNull();

		// 退出登录（reset）只清密钥记录，保留用户对「记住」的选择
		vaultKeys.setRemember(true);
		vaultKeys.reset();
		expect(vaultKeys.remember).toBe(true);
		expect(kv.getItem("pickpen:vaultpref:v1:test-scope-pref")).not.toBeNull();
		vaultKeys.reset();
	});

	it("偏好记录损坏时按「关闭」处理：不能悄悄把密钥/密码再写回本机", async () => {
		const kv = memoryKV();
		vaultKeys.reset();
		kv.setItem("pickpen:vaultpref:v1:test-scope-badpref", "not-json");
		vaultKeys.configure(kv, "test-scope-badpref");
		expect(vaultKeys.remember).toBe(false);
		expect(JSON.parse(kv.getItem("pickpen:vaultpref:v1:test-scope-badpref") ?? "null")).toEqual({
			schema: 1,
			remember: false,
		});
		vaultKeys.reset();
	});

	it("查看密码：解锁后可取到密码，上锁/退出即清空；开启记住时随密钥落盘并跨重启恢复", async () => {
		const kv = memoryKV();
		vaultKeys.reset();
		vaultKeys.configure(kv, "test-scope-pwd");
		const { params } = await createVaultKey(PASSWORD);
		vaultKeys.syncRemote({ vaultId: "91", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("91", params);
		expect(vaultKeys.getVaultPassword()).toBe(""); // 还没输入过密码

		await vaultKeys.unlock(PASSWORD);
		expect(vaultKeys.getVaultPassword()).toBe(PASSWORD);

		// 重开插件：自动解锁的同时密码也要恢复，否则「查看密码」会莫名消失
		vaultKeys.lock();
		expect(vaultKeys.getVaultPassword()).toBe("");
		expect(await vaultKeys.tryRestoreRemembered()).toBe(true);
		expect(vaultKeys.getVaultPassword()).toBe(PASSWORD);

		// 关闭记住：整条记录（密钥 + 密码）一并清除，本次会话的解锁态不受影响
		vaultKeys.setRemember(false);
		expect(kv.getItem("pickpen:vaultkey:v1:test-scope-pwd")).toBeNull();
		expect(vaultKeys.isLocked()).toBe(false);
		expect(vaultKeys.getVaultPassword()).toBe(PASSWORD);

		// 内部上锁（换绑/密钥变更）后不再展示密码
		vaultKeys.lock();
		expect(vaultKeys.getVaultPassword()).toBe("");
		vaultKeys.reset();
		expect(vaultKeys.getVaultPassword()).toBe("");
	});

	it("升级前的记忆记录没有密码字段：仍可自动解锁，只是「查看密码」要等下次输入", async () => {
		const kv = memoryKV();
		vaultKeys.reset();
		vaultKeys.configure(kv, "test-scope-legacy");
		const { params, dek } = await createVaultKey(PASSWORD);
		const hex = Array.from(dek)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		kv.setItem(
			"pickpen:vaultkey:v1:test-scope-legacy",
			JSON.stringify({ schema: 1, vaultId: "92", keyVersion: "1", dek: hex }),
		);
		vaultKeys.syncRemote({ vaultId: "92", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("92", params);
		expect(await vaultKeys.tryRestoreRemembered()).toBe(true);
		expect(vaultKeys.isLocked()).toBe(false);
		expect(vaultKeys.getVaultPassword()).toBe("");
		vaultKeys.reset();
	});

	it("改密码后本机记录里的密码随之更新", async () => {
		const kv = memoryKV();
		vaultKeys.reset();
		vaultKeys.configure(kv, "test-scope-rekey");
		const created = await createVaultKey(PASSWORD);
		vaultKeys.syncRemote({ vaultId: "93", encrypted: true, keyVersion: "1" });
		vaultKeys.setParams("93", created.params);
		await vaultKeys.unlock(PASSWORD);

		const next = "new password";
		vaultKeys.setParams("93", await wrapDekWithPassword(created.dek, next));
		// 改密码 → 密钥版本 +1：旧记忆作废，随后用新密码解锁再写回
		vaultKeys.syncRemote({ vaultId: "93", encrypted: true, keyVersion: "2" });
		await vaultKeys.unlock(next);
		expect(vaultKeys.getVaultPassword()).toBe(next);
		const saved = JSON.parse(kv.getItem("pickpen:vaultkey:v1:test-scope-rekey") ?? "null") as {
			password?: string;
		};
		expect(saved.password).toBe(next);
		vaultKeys.reset();
	});
});

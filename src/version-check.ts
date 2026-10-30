// 版本检查纯逻辑：解析与比较 SemVer，判定「强制升级 / 软提醒 / 无事」。
// 网络请求与 UI 分别在 index.ts / version-gate.ts，这里只保留可直接单测的判定。

/** 服务端下发的版本策略：空串表示该策略未启用 */
export interface VersionPolicy {
	minSupported: string;
	latest: string;
}

/** ok = 无需打扰；soft = 软提醒；force = 不可关闭的升级弹窗 */
export type UpdateLevel = "ok" | "soft" | "force";

/** 版本弹窗形态：与 version-gate 共用同一份定义，避免两处漂移 */
export type VersionModalMode = "force" | "soft";

export interface UpdateVerdict {
	level: UpdateLevel;
	/** soft/force 时要提示的目标版本；ok 时为空串 */
	targetVersion: string;
}

interface Semver {
	major: number;
	minor: number;
	patch: number;
	/** 预发布标识（不含 -），空数组表示正式版 */
	pre: string[];
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** parseVersion 解析 x.y.z（允许 -pre / +build 后缀）：非法返回 null，绝不抛错 */
export function parseVersion(input: string): Semver | null {
	const match = SEMVER_PATTERN.exec(input.trim());
	if (!match) return null;
	const [, major, minor, patch, pre] = match;
	return {
		major: Number(major),
		minor: Number(minor),
		patch: Number(patch),
		pre: pre ? pre.split(".") : [],
	};
}

/** compareVersions 按 SemVer 规则比较；任一版本非法返回 null */
export function compareVersions(a: string, b: string): number | null {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return null;
	for (const key of ["major", "minor", "patch"] as const) {
		if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
	}
	return comparePrerelease(left.pre, right.pre);
}

/** comparePrerelease 预发布低于正式版；逐段比较，数字段小于字母段 */
function comparePrerelease(left: string[], right: string[]): number {
	if (left.length === 0 || right.length === 0) {
		// 都为空 → 相等；只有一方为空 → 正式版更大
		return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
	}
	for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
		const a = left[index];
		const b = right[index];
		if (a === b) continue;
		const aNumeric = /^\d+$/.test(a);
		const bNumeric = /^\d+$/.test(b);
		if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
		if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
		return a < b ? -1 : 1;
	}
	return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

/**
 * evaluateVersionPolicy 判定当前版本应采取的动作。
 * - 当前版本非法（本地改过 manifest 等）→ ok：宁可漏提醒，也不能把开发中的构建锁死；
 * - 低于最低支持版本 → force，目标优先取不低于 min 的最新版本；
 * - 其余低于最新版本 → soft；
 * - 服务端字段非法时按未设置处理，不影响另一个字段生效。
 */
export function evaluateVersionPolicy(current: string, policy: VersionPolicy): UpdateVerdict {
	if (!parseVersion(current)) return { level: "ok", targetVersion: "" };

	const toMin = policy.minSupported ? compareVersions(current, policy.minSupported) : null;
	if (toMin !== null && toMin < 0) {
		const latestOk = policy.latest ? compareVersions(policy.latest, policy.minSupported) : null;
		const target = latestOk !== null && latestOk >= 0 ? policy.latest : policy.minSupported;
		return { level: "force", targetVersion: target };
	}

	const toLatest = policy.latest ? compareVersions(current, policy.latest) : null;
	if (toLatest !== null && toLatest < 0) return { level: "soft", targetVersion: policy.latest };

	return { level: "ok", targetVersion: "" };
}

/** shouldNotifyVersion 同一目标版本每设备只软提醒一次；目标变化（服务端发新版）后重新提醒 */
export function shouldNotifyVersion(target: string, lastNotified: string | undefined): boolean {
	return target !== "" && target !== lastNotified;
}

/**
 * versionModalKey 弹窗去重键：形态、目标版本或对应档位的升级说明任一变化都要重建弹窗，
 * 保证用户在弹窗打开期间也能看到服务端的最新文案。
 */
export function versionModalKey(mode: VersionModalMode, targetVersion: string, notes: string): string {
	return `${mode}:${targetVersion}:${notes}`;
}

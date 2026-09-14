/** 仅用于展示的同步阶段进度，不参与同步决策或持久化。 */
export type SyncPhase = "preparing" | "remote" | "scanning" | "planning" | "downloading" | "verifying" | "uploading" | "committing" | "applying" | "recovering" | "finishing" | "waiting";

export interface SyncProgress {
	phase: SyncPhase;
	completed: number;
	total: number | null;
	activePaths: string[];
}
export type ProgressUpdate = Omit<SyncProgress, "phase">;
export type ProgressCallback = (progress: ProgressUpdate) => void;

/** Map 保留开始顺序；每次回调提供独立快照，避免并发完成后展示旧路径。 */
export class ProgressTracker {
	private completed = 0;
	private active = new Map<symbol, string>();
	constructor(private total: number, private onProgress?: ProgressCallback) { this.report(); }
	start(path: string): (completed?: boolean) => void {
		const key = Symbol();
		this.active.set(key, path);
		this.report();
		return (completed = true) => {
			if (!this.active.delete(key)) return;
			if (completed) this.completed++;
			this.report();
		};
	}
	async track<T>(path: string, task: () => Promise<T>): Promise<T> {
		const finish = this.start(path);
		let completed = false;
		try {
			const result = await task();
			completed = true;
			return result;
		} finally {
			finish(completed);
		}
	}
	private report(): void {
		this.onProgress?.({ completed: this.completed, total: this.total, activePaths: [...this.active.values()] });
	}
}

const labels: Record<SyncPhase, string> = {
	preparing: "正在准备同步", remote: "正在获取远端信息", scanning: "正在扫描",
	planning: "正在比较变更", downloading: "正在下载", verifying: "正在校验本地变更",
	uploading: "正在上传", committing: "正在提交变更", applying: "正在应用本地变更",
	recovering: "正在恢复未完成的同步", finishing: "正在完成同步", waiting: "等待重新同步",
};
export function formatProgress(progress: SyncProgress): { text: string; path: string } {
	const verb = progress.phase === "uploading" || progress.phase === "downloading" ? "已完成" : "已处理";
	const count = progress.total === null ? "" : `，${verb} ${progress.completed}/${progress.total} 项`;
	const [first, ...others] = progress.activePaths;
	return {
		text: labels[progress.phase] + count,
		path: first ? `当前文件：${first}${others.length ? `（另有 ${others.length} 项正在处理）` : ""}` : "",
	};
}

/** 进度百分比（0-100 整数，向下取整：未全部完成时不显示 100%）；总量未知或为空时不显示进度条 */
export function progressPercent(progress: SyncProgress): number | null {
	if (progress.total === null || progress.total <= 0) return null;
	return Math.min(100, Math.floor((progress.completed / progress.total) * 100));
}

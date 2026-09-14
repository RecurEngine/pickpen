/** 合并同阶段的高频通知；阶段或主状态变化立即显示。 */
export class StatusRefresh {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private key: string | null = null;
	constructor(private refresh: () => void) {}
	request(key: string): void {
		if (key !== this.key) {
			this.cancel();
			this.key = key;
			this.refresh();
		} else if (this.timer === null) {
			this.timer = setTimeout(() => {
				this.timer = null;
				this.refresh();
			}, 100);
		}
	}
	cancel(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		this.key = null;
	}
}

import { Setting } from "obsidian";

import { openExternal } from "./external-link";

/** 仅接受服务端下发的绝对 HTTPS 地址，避免打开无效或不安全的协议。 */
export function resolvePricingURL(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		const url = new URL(trimmed);
		return url.protocol === "https:" ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/** 在订阅方案区域渲染统一的官网价格说明入口。 */
export function renderPricingLink(parent: HTMLElement, value: string): void {
	const pricingURL = resolvePricingURL(value);
	const row = new Setting(parent)
		.setName("订阅价格说明")
		.setDesc(pricingURL ? "查看各订阅档位的价格与权益" : "价格说明暂不可用");
	row.addButton((button) => {
		button.setButtonText(pricingURL ? "前往官网" : "暂不可用").setDisabled(!pricingURL);
		if (pricingURL) button.onClick(() => openExternal(pricingURL));
	});
}

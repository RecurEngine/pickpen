// 设置页「关于与反馈」区块：产品简介、支持邮箱、微信群二维码、邮件反馈（自动带诊断上下文）。
// 联系方式为常量（不随 data.json / 会话）；二维码为远程图，展示时自适应小尺寸（见 styles.css）。

import { ButtonComponent, Notice, Platform, Setting } from "obsidian";

import { debugLog } from "./debug-log";
import { openExternal } from "./external-link";
import type PickpenPlugin from "./index";
import { syncState } from "./sync-state";
import { BASE_URL, BUILD_TAG } from "./types";

// —— 联系方式常量（按需修改）——
const SUPPORT_EMAIL = "pickpen@rrecurengine.com";
const WECHAT_QR_URL = "https://rrecurengine.com/images/pickpen-contact.jpg"; // 912×1354 竖图，CSS 自适应缩略
const FEEDBACK_TOPIC = "Pickpen Sync 反馈";

// buildContext 收集诊断上下文，拼进反馈邮件正文（帮用户省去手抄排查信息）
function buildContext(plugin: PickpenPlugin): string {
	const isDesktop = Platform.isDesktopApp;
	const buildLabel = BUILD_TAG ? `本地构建 ${BUILD_TAG}` : "正式版";
	const lines: string[] = [];
	lines.push(`插件版本：${plugin.manifest.version}（${buildLabel}）`);
	lines.push(`远端环境：${BASE_URL}`);
	lines.push(`平台：${isDesktop ? "桌面端" : "移动端"}`);
	lines.push(`设备 ID：${plugin.settings.deviceId}`);
	if (plugin.settings.email) lines.push(`账号：${plugin.settings.email}`);
	lines.push(`绑定仓库：${plugin.settings.vaultName ? `${plugin.settings.vaultName}（id=${plugin.settings.vaultId}）` : "未绑定"}`);
	const st: string[] = [];
	if (syncState.pausedReason) st.push(`暂停：${syncState.pausedReason}`);
	if (syncState.lastError) st.push(`错误：${syncState.lastError}`);
	if (syncState.lastSyncAt) st.push(`最后同步：${new Date(syncState.lastSyncAt).toLocaleString("zh-CN", { hour12: false })}`);
	if (st.length) lines.push(`同步状态：${st.join("；")}`);
	const tail = plugin.settings.debugLog ? debugLog.dump().slice(-80) : [];
	if (tail.length) {
		lines.push("");
		lines.push("---- 最近调试日志 ----");
		for (const e of tail) lines.push(`${e.time} [${e.level.toUpperCase()}] ${e.message}`);
	}
	lines.push("");
	lines.push("---- 请在此补充问题描述 ----");
	return lines.join("\n");
}

// openMailto 跨端唤起系统邮件（mailto 经系统外部协议处理）
function openMailto(to: string, subject: string, body?: string): void {
	const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}${body !== undefined ? `&body=${encodeURIComponent(body)}` : ""}`;
	openExternal(url);
}

export function renderAboutAndFeedback(containerEl: HTMLElement, plugin: PickpenPlugin): void {
	new Setting(containerEl).setHeading().setName("关于与反馈");
	// 与其他分组相同：标题位于顶层，子项统一放进缩进容器。
	const root = containerEl.createDiv({ cls: "pickpen-about pickpen-settings-section" });

	// 产品简介
	const introSetting = new Setting(root).setName("Pickpen Sync");
	introSetting.descEl.createDiv({
		cls: "pickpen-about-intro",
		text: "Obsidian 笔记的多端快照同步插件：同一账号多设备同时使用、自动合并冲突并保留副本、支持版本历史。本地优先，数据随时可从云端恢复。",
	});

	// 邮件反馈：自动附带诊断上下文
	new Setting(root)
		.setName("意见反馈")
		.setDesc("反馈问题或建议。点击会在本地生成邮件草稿并附带版本、账号和设备信息；仅在调试日志已开启时附带日志，发送前可自行检查或删除。")
		.addButton((btn) =>
			btn
				.setButtonText("邮件反馈")
				.setCta()
				.onClick(() => {
					try {
						openMailto(SUPPORT_EMAIL, FEEDBACK_TOPIC, buildContext(plugin));
						new Notice("已唤起邮件客户端");
					} catch {
						new Notice(`无法唤起邮件客户端，请手动发送至 ${SUPPORT_EMAIL}`);
					}
				}),
		);

	// 支持邮箱
	new Setting(root)
		.setName("支持邮箱")
		.setDesc(SUPPORT_EMAIL)
		.addButton((btn) =>
			btn
				.setButtonText("发邮件")
				.onClick(() => {
					openMailto(SUPPORT_EMAIL, FEEDBACK_TOPIC);
					new Notice("已唤起邮件客户端");
				}),
		);

	// 微信：远程二维码自适应小尺寸展示 + 下方「在浏览器打开大图」按钮（移动端长按大图可保存/识别）
	const wechatSetting = new Setting(root).setName("微信");
	wechatSetting.descEl.createDiv({ cls: "pickpen-about-intro", text: "你提需求、我们来实现——加入用户群，一起把 Pickpen Sync 做成你想要的工具。" });
	wechatSetting.descEl.createDiv({ cls: "pickpen-about-intro", text: "内测用户专属：新功能提前解锁，容量福利不定期发放。" });
	wechatSetting.descEl.createDiv({ cls: "pickpen-about-intro", text: "抢先体验新功能 · 开发者在线答疑 · 你的建议直接变成产品功能。" });
	const qrWrap = root.createDiv({ cls: "pickpen-contact-qr" });
	const img = qrWrap.createEl("img", {
		attr: {
			src: WECHAT_QR_URL,
			alt: "Pickpen Sync 微信二维码",
			loading: "lazy",
			referrerpolicy: "no-referrer",
		},
	});
	// 二维码下方按钮：系统浏览器打开大图（长按可保存到相册，再去微信扫一扫/识别）
	const openRow = qrWrap.createDiv({ cls: "pickpen-contact-qr-actions" });
	new ButtonComponent(openRow)
		.setButtonText("在浏览器打开大图")
		.onClick(() => {
			try {
				openExternal(WECHAT_QR_URL);
				new Notice("已尝试在系统浏览器打开二维码大图");
			} catch {
				new Notice(`无法打开，请手动访问 ${WECHAT_QR_URL}`);
			}
		});
	img.addEventListener("error", () => {
		// 图加载失败时降级为文字提示 + 打开大图按钮仍可用（直接去浏览器看原图）
		qrWrap.empty();
		qrWrap.createDiv({
			cls: "pickpen-contact-qr-fallback",
			text: `二维码缩略图加载失败，可用下方按钮在浏览器打开原图，或邮件联系我们。`,
		});
		const fallbackRow = qrWrap.createDiv({ cls: "pickpen-contact-qr-actions" });
		new ButtonComponent(fallbackRow)
			.setButtonText("在浏览器打开二维码大图")
			.onClick(() => openExternal(WECHAT_QR_URL));
	});
}

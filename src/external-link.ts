// 统一通过 Obsidian 的 external-link 机制打开系统外部页面。
// 桌面端走系统浏览器，移动端交给系统浏览器处理。
// 官网链接请使用 website-link.ts 的 openWebsite（自动附带一次性登录票据）；
// 本函数用于 mailto、二维码、社区插件页等非官网外链。
export function openExternal(url: string): void {
	const link = createEl("a");
	link.href = url;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	link.className = "external-link";
	link.hidden = true;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
}

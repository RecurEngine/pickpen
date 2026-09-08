// 统一通过 Obsidian 的 external-link 机制打开系统外部页面。
// 桌面端走系统浏览器，移动端交给系统浏览器处理。
export function openExternal(url: string): void {
	const link = document.createElement("a");
	link.href = url;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	link.className = "external-link";
	link.hidden = true;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
}

// 复制文本到系统剪贴板：全插件统一出口。
// 只走 Clipboard API，不使用已废弃的 document.execCommand 回退——
// 移动端 WebView 若不可用则返回 false，由调用方提示用户手动复制。
export async function copyText(value: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(value);
		return true;
	} catch {
		return false;
	}
}

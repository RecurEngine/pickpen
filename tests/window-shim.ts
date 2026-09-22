// 插件源码统一走 window.setTimeout / window.clearTimeout（弹出窗口兼容），
// 而 vitest 跑在 node 环境、没有 window。这里把 globalThis 自身挂成 window，
// 而不是拷贝一份 setTimeout/clearTimeout：属性按调用时刻动态取值，
// vi.useFakeTimers() 换掉全局计时器之后，window.setTimeout 仍会命中假计时器。
const g = globalThis as { window?: unknown };
if (typeof g.window === "undefined") g.window = globalThis;

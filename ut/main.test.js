/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const boot = require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const ResizePicsPlugin = require("../src/main");
const { makeFakePlugin } = require("./helpers/fakePlugin");

// ---------------------------------------------------------------------------
// main.js 的 resize 命令入口是 resizePicsToFontSize。它通过 view →
// resizeJob.run(view) 串起任务；为了隔离 resize.js / ocr.js，这里把
// this.resizeJob 换成可控 stub，专测 main.js 的结果与 Notice 分支：
//   - 已在运行 → 直接返回
//   - 没有 MarkdownView → 弹 noView Notice
//   - result.aborted → 弹 aborted Notice
//   - result.considered=0 → 弹 noImages Notice
//   - 正常路径 → 弹 resized Notice，模板填参
//   - resizeJob.run 抛非本地化错误 → 弹带 resize-pics: 前缀的 Notice
//   - resizeJob.run 抛已本地化错误 → 不重复前缀
// 依赖操作和卸载交错等生命周期分支由 concurrent.test.js 覆盖。
// ---------------------------------------------------------------------------

/**
 * 直接 new 出插件实例，绕过 Obsidian 加载器；然后调用 onload 触发默认设置
 * 加载。这样后续可以直接调 plugin.resizePicsToFontSize()。
 */
async function bootPlugin(runResult) {
    const fake = makeFakePlugin();
    // 用 fake 的 app / manifest 直接构造 ResizePicsPlugin。obsidian 的
    // Plugin 构造函数已经在 bootstrap 里替换成把 (app, manifest) 保留到实
    // 例上的最小实现，所以这里两个参数会被 super() 保存。
    const plugin = new ResizePicsPlugin(fake.app, fake.manifest);
    // main.js 里通过 this.app.workspace.getActiveViewOfType 拿视图 —— fake
    // 会把返回值透传成 overrides.activeView（默认 null）。测试里改这个字段
    // 就能覆盖 “no view” / “有 view” 两条路。
    plugin.__setActiveView = (v) => { plugin.app.workspace.getActiveViewOfType = () => v; };
    // loadData / saveData 走 fake 的内存实现
    plugin.loadData = fake.loadData.bind(fake);
    plugin.saveData = fake.saveData.bind(fake);
    await plugin.onload();
    // 替换 job.run 为可控 stub
    plugin.resizeJob = {
        async run(_view) {
            if (typeof runResult === "function") return runResult();
            return runResult;
        },
        async dispose() {},
    };
    return plugin;
}

function fakeView() {
    // resizeJob.run 只用到 view.file / view.containerEl，这里给最小对象。
    return { file: { path: "note.md" }, containerEl: {} };
}

test("已经在运行时立刻返回，什么 Notice 也不弹", async () => {
    boot.resetNotices();
    const plugin = await bootPlugin({ considered: 1, resized: 1, skipped: 0, aborted: false });
    plugin.resizing = true;
    plugin.__setActiveView(fakeView());
    await plugin.resizePicsToFontSize();
    assert.equal(boot.noticeLog.length, 0);
});

test("没有 MarkdownView → 弹 noView（用当前语言）", async () => {
    boot.resetNotices();
    const plugin = await bootPlugin({ considered: 1, resized: 1, skipped: 0, aborted: false });
    plugin.__setActiveView(null);
    await plugin.resizePicsToFontSize();
    assert.equal(boot.noticeLog.length, 1);
    assert.match(boot.noticeLog[0].message, /请先打开一个 Markdown 视图/);
});

test("按下命令后立刻弹起始 Notice，run 完成前用户能看到反馈", async () => {
    boot.resetNotices();
    // 让 run 在我们释放之前一直挂起 —— 断言起始 Notice 在 run 完成前
    // 就已经进入 log。
    let release;
    const runFinished = new Promise((resolve) => { release = resolve; });
    const plugin = await bootPlugin(() => runFinished
        .then(() => ({ considered: 1, resized: 1, skipped: 0, aborted: false })));
    plugin.__setActiveView(fakeView());
    const done = plugin.resizePicsToFontSize();

    // 让 microtask 队列跑完，起始 Notice 应该已经落地。
    await Promise.resolve();
    assert.equal(boot.noticeLog.length, 1);
    assert.match(boot.noticeLog[0].message, /正在缩放图片/);

    release();
    await done;
    // 完成后应追加一条结果 Notice。
    assert.equal(boot.noticeLog.length, 2);
    assert.match(boot.noticeLog[1].message, /已缩放 1 张图片/);
});

test("run 返回 aborted → 弹 aborted，不弹 resized", async () => {
    boot.resetNotices();
    const plugin = await bootPlugin({ considered: 3, resized: 0, skipped: 0, aborted: true });
    plugin.__setActiveView(fakeView());
    await plugin.resizePicsToFontSize();
    // 起始 Notice + aborted Notice
    assert.equal(boot.noticeLog.length, 2);
    assert.match(boot.noticeLog[0].message, /正在缩放图片/);
    assert.match(boot.noticeLog[1].message, /不要编辑文件/);
});

test("run 返回 considered=0 → 弹 noImages", async () => {
    boot.resetNotices();
    const plugin = await bootPlugin({ considered: 0, resized: 0, skipped: 0, aborted: false });
    plugin.__setActiveView(fakeView());
    await plugin.resizePicsToFontSize();
    // 起始 Notice + noImages Notice
    assert.match(boot.noticeLog[1].message, /没有找到可缩放的图片/);
});

test("run 正常 → 弹 resized，模板参数填对", async () => {
    boot.resetNotices();
    const plugin = await bootPlugin({ considered: 5, resized: 3, skipped: 2, aborted: false });
    plugin.__setActiveView(fakeView());
    await plugin.resizePicsToFontSize();
    // 起始 Notice + 结果 Notice
    // 中文模板 "已缩放 {count} 张图片（跳过 {skipped} 张）"
    assert.match(boot.noticeLog[1].message, /已缩放 3 张图片（跳过 2 张）/);
});

test("run 抛已本地化错误 → 不重复 resize-pics 前缀", async () => {
    boot.resetNotices();
    const plugin = await bootPlugin(() => { throw new Error("resize-pics：某个内部错误"); });
    plugin.__setActiveView(fakeView());
    await plugin.resizePicsToFontSize();
    // 起始 Notice + 错误 Notice
    const msg = boot.noticeLog[1].message;
    // 应该只有一次 "resize-pics：" —— 匹配的字符串出现次数 = 1
    const count = msg.split(/resize-pics[:：]/).length - 1;
    assert.equal(count, 1);
});

test("run 抛裸错误 → 手动加 resize-pics: 前缀", async () => {
    boot.resetNotices();
    const plugin = await bootPlugin(() => { throw new Error("random exception"); });
    plugin.__setActiveView(fakeView());
    await plugin.resizePicsToFontSize();
    // 起始 Notice + 错误 Notice
    assert.match(boot.noticeLog[1].message, /^resize-pics: random exception$/);
});

test("成功后 resizing 复位为 false，可再次触发", async () => {
    boot.resetNotices();
    let calls = 0;
    const plugin = await bootPlugin(() => { calls += 1; return { considered: 0, resized: 0, skipped: 0, aborted: false }; });
    plugin.__setActiveView(fakeView());
    await plugin.resizePicsToFontSize();
    await plugin.resizePicsToFontSize();
    assert.equal(calls, 2);
    assert.equal(plugin.resizing, false);
});

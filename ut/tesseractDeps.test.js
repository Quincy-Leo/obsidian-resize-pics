/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const boot = require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { makeFakePlugin, sha256Hex } = require("./helpers/fakePlugin");
const { loadWithAssets } = require("./helpers/loadTesseractDeps");

// 生成小的可控字节 + sha256 —— 覆盖 downloadAll 里 “哈希匹配” 分支时必须
// 让测试资产的 sha256 常量和真实内容一致。用两组固定字节：一组是“正确”
// 内容（hashOK），一组是“损坏”内容（hashBAD）。
//
// 注意用 Uint8Array 而不是 Node Buffer：Buffer.buffer 指向 Node 的共享池
// 而不是独立的 ArrayBuffer，`.slice(0)` 出来的 ArrayBuffer 会带上池里
// 其它 Buffer 的字节，导致 sha256 完全对不上。
const BYTES_OK = Uint8Array.from(Buffer.from("hello resize-pics"));
const BYTES_BAD = Uint8Array.from(Buffer.from("corrupt"));
const SHA_OK = sha256Hex(BYTES_OK);

/** 拷贝 Uint8Array 内容到独立 ArrayBuffer —— 用作 writeBinary / requestUrl 的入参。 */
function toAB(u8) {
    const ab = new ArrayBuffer(u8.byteLength);
    new Uint8Array(ab).set(u8);
    return ab;
}

function makeAssets() {
    return [
        { name: "a.bin", url: "https://example.test/a.bin", sha256: SHA_OK },
        { name: "b.bin", url: "https://example.test/b.bin", sha256: SHA_OK },
    ];
}

function pluginWithDir() {
    const p = makeFakePlugin();
    p.manifest.dir = ".obsidian/plugins/resize-pics";
    return p;
}

test("pluginDir 未设置时抛错", () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const p = makeFakePlugin();
    p.manifest.dir = null;
    const m = new TesseractDependencyManager(p);
    assert.throws(() => m.pluginDir, /plugin\.manifest\.dir/);
});

test("checkStatus: 全部缺失", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const m = new TesseractDependencyManager(pluginWithDir());
    const s = await m.checkStatus();
    assert.deepEqual(s.missing, ["a.bin", "b.bin"]);
    assert.equal(s.installed.length, 0);
    assert.equal(s.total, 2);
});

test("checkStatus: 文件存在且哈希正确 → installed", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = pluginWithDir();
    const m = new TesseractDependencyManager(plugin);
    await plugin.app.vault.adapter.writeBinary(m.getAssetPath("a.bin"), toAB(BYTES_OK));
    const s = await m.checkStatus();
    assert.deepEqual(s.installed, ["a.bin"]);
    assert.deepEqual(s.missing, ["b.bin"]);
});

test("checkStatus: 文件存在但哈希错误 → 视为缺失", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = pluginWithDir();
    const m = new TesseractDependencyManager(plugin);
    await plugin.app.vault.adapter.writeBinary(m.getAssetPath("a.bin"), toAB(BYTES_BAD));
    const s = await m.checkStatus();
    assert.ok(s.missing.includes("a.bin"));
});

test("checkStatus({verifyHash:false}) 只判 exists，不做 SHA 校验", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = pluginWithDir();
    const m = new TesseractDependencyManager(plugin);
    // 写入错误内容
    await plugin.app.vault.adapter.writeBinary(m.getAssetPath("a.bin"), toAB(BYTES_BAD));
    const s = await m.checkStatus({ verifyHash: false });
    assert.ok(s.installed.includes("a.bin"));
});

test("downloadAll: 空盘 → 走 requestUrl 下载并写盘，onProgress 报告 start/done", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = pluginWithDir();
    const m = new TesseractDependencyManager(plugin);
    boot.setRequestUrl(async ({ url }) => ({
        status: 200,
        arrayBuffer: toAB(BYTES_OK),
    }));
    const events = [];
    const res = await m.downloadAll((p) => events.push(p.phase));
    assert.equal(res.downloaded, 2);
    assert.equal(res.skipped, 0);
    assert.equal(res.failed.length, 0);
    assert.deepEqual(events, ["start", "done", "start", "done"]);
    // 文件已就位
    assert.equal(plugin.app.vault.adapter.files.has(m.getAssetPath("a.bin")), true);
});

test("downloadAll: 已经存在且哈希正确 → skipped", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = pluginWithDir();
    const m = new TesseractDependencyManager(plugin);
    for (const name of ["a.bin", "b.bin"]) {
        await plugin.app.vault.adapter.writeBinary(m.getAssetPath(name), toAB(BYTES_OK));
    }
    let requestCalls = 0;
    boot.setRequestUrl(async () => { requestCalls += 1; return { status: 200, arrayBuffer: toAB(BYTES_OK) }; });
    const res = await m.downloadAll();
    assert.equal(res.skipped, 2);
    assert.equal(res.downloaded, 0);
    assert.equal(requestCalls, 0, "已存在时不应二次下载");
});

test("downloadAll: 已存在但哈希错误 → 删除并标 failed，同 batch 不重试", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = pluginWithDir();
    const m = new TesseractDependencyManager(plugin);
    // b.bin 事先放好正确内容（走 case B / skipped），只让 a.bin 处于哈希错误
    // 状态，专测 case C。requestUrl 抛错就是为了断言 case C 不会退化到重下。
    await plugin.app.vault.adapter.writeBinary(m.getAssetPath("a.bin"), toAB(BYTES_BAD));
    await plugin.app.vault.adapter.writeBinary(m.getAssetPath("b.bin"), toAB(BYTES_OK));
    boot.setRequestUrl(async () => { throw new Error("should not be called for case C"); });
    const res = await m.downloadAll();
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].name, "a.bin");
    assert.ok(res.failed[0].error.includes("sha256"));
    // 被删掉了
    assert.equal(plugin.app.vault.adapter.files.has(m.getAssetPath("a.bin")), false);
});

test("downloadAll: HTTP 非 2xx → failed", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = pluginWithDir();
    const m = new TesseractDependencyManager(plugin);
    boot.setRequestUrl(async () => ({ status: 500, arrayBuffer: new ArrayBuffer(0) }));
    const res = await m.downloadAll();
    assert.equal(res.failed.length, 2);
    for (const f of res.failed) assert.match(f.error, /HTTP 500/);
});

test("downloadAll: 下载内容 hash 不匹配 → 不写盘、failed", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = pluginWithDir();
    const m = new TesseractDependencyManager(plugin);
    boot.setRequestUrl(async () => ({
        status: 200,
        arrayBuffer: toAB(BYTES_BAD),
    }));
    const res = await m.downloadAll();
    assert.equal(res.failed.length, 2);
    // 从没写过
    assert.equal(plugin.app.vault.adapter.files.has(m.getAssetPath("a.bin")), false);
});

test("downloadAll: 已在下载中 → 立刻返回 null（不重入）", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = pluginWithDir();
    const m = new TesseractDependencyManager(plugin);
    m.downloading = true; // 手动模拟
    const res = await m.downloadAll();
    assert.equal(res, null);
});

test("clearCache: 移除已有资产并汇报", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = pluginWithDir();
    const m = new TesseractDependencyManager(plugin);
    boot.resetIdb();
    await plugin.app.vault.adapter.writeBinary(m.getAssetPath("a.bin"), toAB(BYTES_OK));
    await plugin.app.vault.adapter.writeBinary(m.getAssetPath("b.bin"), toAB(BYTES_OK));
    const res = await m.clearCache();
    assert.deepEqual(res.removed.sort(), ["a.bin", "b.bin"]);
    assert.equal(plugin.app.vault.adapter.files.size, 0);
    // evictedKeys: IDB 里没写过任何 key，所以是空数组（不能报错）。
    assert.deepEqual(res.evictedKeys, []);
});

test("clearCache: 并发第二次 → null", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = pluginWithDir();
    const m = new TesseractDependencyManager(plugin);
    m.clearing = true;
    const res = await m.clearCache();
    assert.equal(res, null);
});

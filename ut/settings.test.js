/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    LANGUAGE_OPTIONS,
    ResizePicsSettings,
    bilingualError,
    localizedError,
} = require("../src/settings");
const { makeFakePlugin } = require("./helpers/fakePlugin");

// bilingualError 用于 settings.load 失败等 “还不知道用户选了哪种语言” 的场景，
// 期望是把每种语言的模板都渲染一遍再用换行拼起来。
test("bilingualError 合并所有语言的模板并填参数", () => {
    const msg = bilingualError("settingsBadVersion", { actual: '"x"', expected: 1 });
    assert.ok(msg.includes("resize-pics：不支持的配置文件版本 \"x\"；期望值为 1。"), "should contain zh line");
    assert.ok(msg.includes("resize-pics: unsupported settings version \"x\"; expected 1."), "should contain en line");
    assert.equal(msg.split("\n").length, LANGUAGE_OPTIONS.length);
});

test("localizedError 只用当前 uiText 里的模板", () => {
    const zh = LANGUAGE_OPTIONS.find((o) => o.value === "zh-CN");
    const s = localizedError(zh, "noContentRoot");
    assert.equal(s, "resize-pics：获取正文字号失败。");
});

test("load: 新装（loadData 返回 null）时写入默认语言", async () => {
    const plugin = makeFakePlugin();
    const s = new ResizePicsSettings(plugin);
    const v = await s.load();
    assert.equal(v.version, 1);
    assert.equal(v.language, "zh-CN");
});

test("load: 缺 version 字段直接抛错，且错误含双语提示", async () => {
    const plugin = makeFakePlugin();
    plugin._dataStore.current = { language: "en" }; // 老数据无 version
    const s = new ResizePicsSettings(plugin);
    await assert.rejects(() => s.load(), (err) => {
        assert.ok(err.message.includes("resize-pics"));
        // 双语拼接：两种语言各一行
        assert.equal(err.message.split("\n").length, LANGUAGE_OPTIONS.length);
        return true;
    });
});

test("load: version 不匹配抛错", async () => {
    const plugin = makeFakePlugin();
    plugin._dataStore.current = { version: 999, language: "en" };
    const s = new ResizePicsSettings(plugin);
    await assert.rejects(() => s.load(), /999/);
});

test("load: 非法 language 回退到默认 zh-CN", async () => {
    const plugin = makeFakePlugin();
    plugin._dataStore.current = { version: 1, language: "xx-YY" };
    const s = new ResizePicsSettings(plugin);
    const v = await s.load();
    assert.equal(v.language, "zh-CN");
});

test("setLanguage: 未知语言无副作用，也不触发回调", async () => {
    const plugin = makeFakePlugin();
    let called = 0;
    const s = new ResizePicsSettings(plugin, () => { called += 1; });
    await s.load();
    await s.setLanguage("fr-FR");
    assert.equal(called, 0);
    assert.equal(s.value.language, "zh-CN");
});

test("setLanguage: 合法语言写盘并触发 onLanguageChanged", async () => {
    const plugin = makeFakePlugin();
    let called = 0;
    const s = new ResizePicsSettings(plugin, () => { called += 1; });
    await s.load();
    await s.setLanguage("en");
    assert.equal(called, 1);
    assert.equal(plugin._dataStore.current.language, "en");
});

test("save 失败时回滚 value 并重新抛出", async () => {
    const plugin = makeFakePlugin();
    const s = new ResizePicsSettings(plugin);
    await s.load();
    // 制造 saveData 失败：先切到 en 但让 saveData 抛错
    plugin.saveData = async () => { throw new Error("disk full"); };
    // 之前已存的持久化状态是 zh-CN，加载回滚后 value.language 应回到 zh-CN。
    plugin._dataStore.current = { version: 1, language: "zh-CN" };
    await assert.rejects(() => s.setLanguage("en"), /disk full/);
    // 回滚后再校验 —— setLanguage 内部会尝试重新 load，覆盖内存里的临时值。
    assert.equal(s.value.language, "zh-CN");
});

test("uiText: language 未初始化时兜底 LANGUAGE_OPTIONS[0]", () => {
    const plugin = makeFakePlugin();
    const s = new ResizePicsSettings(plugin);
    assert.equal(s.uiText, LANGUAGE_OPTIONS[0]);
});

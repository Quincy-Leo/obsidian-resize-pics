/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// 加载 src/tesseractDeps.js 的“可测试变体”
// ---------------------------------------------------------------------------
//
// 原模块把 REQUIRED_ASSETS（含真实 CDN URL + 12 MB 文件的 SHA-256）声明为
// 模块作用域的 const，测试里想覆盖 “哈希匹配 / 下载成功” 这条路径时没法
// 从外部改。这里通过源码替换 + 单独 Module 实例的方式装载一个替身：
//
//   1. 读原文件 UTF-8 文本；
//   2. 用正则把整个 REQUIRED_ASSETS 数组替换成传入的测试资产；
//   3. 用一个新 Module 实例 `_compile` 修改后的源码，并返回其 exports。
//
// 这样被测代码本身逻辑没变，测试就能提供小体积、SHA 已知的资产。

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const REAL_PATH = path.resolve(__dirname, "..", "..", "src", "tesseractDeps.js");

function loadWithAssets(assets) {
    const src = fs.readFileSync(REAL_PATH, "utf8");
    // 用非贪婪匹配吞掉从 `const REQUIRED_ASSETS = [` 到 `];` 之间的所有字符。
    const patched = src.replace(
        /const REQUIRED_ASSETS = \[[\s\S]*?\n\];/,
        `const REQUIRED_ASSETS = ${JSON.stringify(assets, null, 2)};`,
    );
    if (patched === src) {
        throw new Error("failed to substitute REQUIRED_ASSETS — regex out of date?");
    }
    const m = new Module(REAL_PATH, module);
    m.filename = REAL_PATH;
    m.paths = Module._nodeModulePaths(path.dirname(REAL_PATH));
    m._compile(patched, REAL_PATH);
    return m.exports;
}

module.exports = { loadWithAssets, REAL_PATH };

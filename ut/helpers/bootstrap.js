/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// 单测运行前的环境准备
// ---------------------------------------------------------------------------
//
// 目的：让 src/ 下的模块能在纯 Node 环境（没有 Obsidian 主进程、没有浏览器
// DOM、没有 IndexedDB）里被 require 并调用。策略是把不存在的运行时依赖用
// 最小可用的 fake 实现替换掉：
//
//   1. `obsidian` 是宿主提供且本项目未安装的运行时模块，这里通过改写
//      Module._resolveFilename 让 `require("obsidian")` 命中测试桩。
//   2. DOM 全局（Image、Blob URL、getComputedStyle 等）走桩，用于
//      resize.js / ocr.js 里的 “读图/OCR” 相关逻辑。
//   3. IndexedDB 走桩，用于 ocr.js 的 idbPutAll / evictOcrCache。
//   4. crypto.subtle / fetch / Blob 直接使用当前 Node 运行时的实现。
//
// 每个测试文件在最前面 `require("./helpers/bootstrap")` 即可。
// 这个文件是幂等的：重复 require 只装一次桩。

const Module = require("node:module");
const path = require("node:path");

if (globalThis.__resizePicsBootstrapped) {
    module.exports = globalThis.__resizePicsBootstrap;
    return;
}
globalThis.__resizePicsBootstrapped = true;

// --- Notice 收集器 --------------------------------------------------------
// 让测试可以断言弹窗内容而不用 mock Notice 类本身。
const noticeLog = [];

// --- obsidian 桩 ----------------------------------------------------------
// 仅实现被 src/ 引用到的成员；行为足够让被测代码走通，但不模拟完整的
// Obsidian API。Setting 控件暴露可检查状态，fake plugin 则补充 app、vault
// 和持久化行为。
class Notice {
    constructor(message, duration) {
        this.message = message;
        this.duration = duration;
        noticeLog.push({ message, duration });
    }
}

class Plugin {
    constructor(app, manifest) {
        this.app = app || {};
        this.manifest = manifest || {};
    }
    // src/main.js 需要的方法 —— 返回值不重要，测试里只关心副作用/参数。
    addCommand(spec) { return spec; }
    addRibbonIcon(_icon, _title, _cb) { return { setAttribute() {} }; }
    addSettingTab(_tab) {}
    removeCommand(_id) {}
    async loadData() { return null; }
    async saveData(_data) {}
}

class MarkdownView {}

class PluginSettingTab {
    constructor(app, plugin) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = createFakeEl();
    }
}

class Setting {
    constructor(containerEl) {
        this.containerEl = containerEl;
        this.descEl = createFakeEl();
        containerEl.children.push(this);
    }
    setName(_n) { return this; }
    setDesc(_d) { return this; }
    setHeading() { return this; }
    addDropdown(cb) { cb(new FakeDropdown()); return this; }
    addButton(cb) { cb(new FakeButton()); return this; }
}

class FakeDropdown {
    constructor() { this.options = []; this.value = null; }
    addOption(v, l) { this.options.push({ v, l }); return this; }
    setValue(v) { this.value = v; return this; }
    onChange(_cb) { this._onChange = _cb; return this; }
}

class FakeButton {
    setButtonText(text) { this.text = text; return this; }
    setDisabled(b) { this.disabled = b; return this; }
    onClick(cb) { this._onClick = cb; return this; }
}

function setTooltip(_el, _text) { /* no-op */ }

// Very small subset of Obsidian's DOM helper contract used in src/.
function createFakeEl() {
    return {
        children: [],
        classes: new Set(),
        text: "",
        style: {},
        attrs: {},
        empty() { this.children = []; },
        createDiv(opts) {
            const el = createFakeEl();
            if (opts) { if (opts.text) el.text = opts.text; if (opts.cls) el.classes.add(opts.cls); }
            this.children.push(el);
            return el;
        },
        setText(t) { this.text = String(t); },
        addClass(c) { this.classes.add(c); },
        removeClass(c) { this.classes.delete(c); },
        setAttribute(k, v) { this.attrs[k] = v; },
        querySelector() { return null },
    };
}

function normalizePath(p) {
    // Mirror Obsidian's behaviour just enough: collapse `//`, strip trailing `/`.
    return String(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

// requestUrl is monkey-patched per test via `setRequestUrl` below.
let requestUrlImpl = async () => { throw new Error("requestUrl not stubbed"); };
function setRequestUrl(fn) { requestUrlImpl = fn; }
async function requestUrl(opts) { return requestUrlImpl(opts); }

const obsidianStub = {
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    MarkdownView,
    setTooltip,
    normalizePath,
    requestUrl,
};

// Patch Module resolver: `require("obsidian")` → our stub. Any other name is
// resolved normally.
const originalResolve = Module._resolveFilename;
const OBSIDIAN_STUB_ID = path.join(__dirname, "__obsidian_stub__.js");
require.cache[OBSIDIAN_STUB_ID] = {
    id: OBSIDIAN_STUB_ID,
    filename: OBSIDIAN_STUB_ID,
    loaded: true,
    exports: obsidianStub,
    children: [],
    paths: [],
};
Module._resolveFilename = function patched(request, parent, ...rest) {
    if (request === "obsidian") return OBSIDIAN_STUB_ID;
    return originalResolve.call(this, request, parent, ...rest);
};

// --- DOM 桩 ---------------------------------------------------------------
// resize.js 里用到：Image、getComputedStyle。测试里通过 setImageLoader /
// setComputedFontSize 注入行为。
let imageLoader = (url) => ({ naturalWidth: 0, naturalHeight: 0, ok: false });
function setImageLoader(fn) { imageLoader = fn; }
globalThis.Image = class {
    constructor() {
        this.onload = null;
        this.onerror = null;
    }
    set src(url) {
        // Defer to next microtask so callers who set onload/onerror after
        // `image.src = ...` still get the callback (matches DOM order).
        Promise.resolve().then(() => {
            const info = imageLoader(url) || { ok: false };
            if (info.ok === false) {
                this.onerror && this.onerror(new Error(`load failed: ${url}`));
                return;
            }
            this.naturalWidth = info.naturalWidth;
            this.naturalHeight = info.naturalHeight;
            this.onload && this.onload();
        });
    }
};

let computedFontSize = "16px";
function setComputedFontSize(px) { computedFontSize = px; }
globalThis.getComputedStyle = () => ({ fontSize: computedFontSize });

// --- IndexedDB 桩 ---------------------------------------------------------
// 只覆盖 ocr.js idbPutAll / evictOcrCache 的用法：open / transaction /
// objectStore.put / openKeyCursor / delete。
const idbState = {
    // dbName → { stores: { storeName → Map<key, value> }, version }
    dbs: new Map(),
};
function resetIdb() { idbState.dbs.clear(); }

globalThis.indexedDB = {
    open(name, _version) {
        const req = { result: null, error: null, onerror: null, onsuccess: null, onupgradeneeded: null };
        setImmediate(() => {
            let db = idbState.dbs.get(name);
            const created = !db;
            if (created) {
                db = { name, stores: new Map(), objectStoreNames: makeNameList([]) };
                idbState.dbs.set(name, db);
            }
            req.result = makeDbHandle(db);
            if (created && req.onupgradeneeded) {
                // Invoked before onsuccess — matches IDB spec.
                req.onupgradeneeded();
            }
            req.onsuccess && req.onsuccess();
        });
        return req;
    },
    deleteDatabase(name) {
        idbState.dbs.delete(name);
        return { onsuccess: null, onerror: null };
    },
};

function makeNameList(arr) {
    return { contains: (n) => arr.includes(n), _arr: arr };
}

function makeDbHandle(db) {
    return {
        objectStoreNames: db.objectStoreNames,
        createObjectStore(name) {
            db.stores.set(name, new Map());
            db.objectStoreNames._arr.push(name);
            db.objectStoreNames = makeNameList(db.objectStoreNames._arr);
        },
        transaction(storeName, _mode) {
            if (!db.stores.has(storeName)) {
                const err = new Error(`store not found: ${storeName}`);
                throw err;
            }
            const store = db.stores.get(storeName);
            const tx = { oncomplete: null, onerror: null, onabort: null };
            const pending = [];
            const finish = () => {
                for (const op of pending) op();
                setImmediate(() => tx.oncomplete && tx.oncomplete());
            };
            tx.objectStore = () => ({
                put(value, key) { pending.push(() => store.set(key, value)); return { onsuccess: null }; },
                openKeyCursor() {
                    const keys = [...store.keys()];
                    const req = { result: null, onsuccess: null };
                    let i = -1;
                    const advance = () => {
                        i += 1;
                        if (i >= keys.length) { req.result = null; req.onsuccess && req.onsuccess(); return; }
                        req.result = { key: keys[i], continue: advance, delete: () => store.delete(keys[i]) };
                        req.onsuccess && req.onsuccess();
                    };
                    setImmediate(advance);
                    return req;
                },
            });
            // Kick the transaction commit after the caller has queued its ops.
            setImmediate(finish);
            return tx;
        },
        close() {},
    };
}

// --- URL.createObjectURL 桩 ----------------------------------------------
let blobUrlSeq = 0;
const blobRegistry = new Map();
globalThis.URL = globalThis.URL || {};
globalThis.URL.createObjectURL = (blob) => {
    blobUrlSeq += 1;
    const url = `blob:test/${blobUrlSeq}`;
    blobRegistry.set(url, blob);
    return url;
};
globalThis.URL.revokeObjectURL = (url) => { blobRegistry.delete(url); };

// --- 导出的钩子 -----------------------------------------------------------
const api = {
    obsidian: obsidianStub,
    noticeLog,
    resetNotices() { noticeLog.length = 0; },
    setRequestUrl,
    setImageLoader,
    setComputedFontSize,
    resetIdb,
    blobRegistry,
};
globalThis.__resizePicsBootstrap = api;
module.exports = api;

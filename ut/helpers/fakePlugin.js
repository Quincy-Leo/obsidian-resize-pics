/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// 内存版 Vault adapter + Plugin，测试里替代 Obsidian 宿主
// ---------------------------------------------------------------------------
//
// 对应真实 API：
//   adapter.exists(path)          -> Promise<boolean>
//   adapter.readBinary(path)      -> Promise<ArrayBuffer>
//   adapter.writeBinary(path, ab) -> Promise<void>
//   adapter.remove(path)          -> Promise<void>
//   adapter.mkdir(path)           -> Promise<void>
//   adapter.rmdir(path, recursive)-> Promise<void>
//
// 存储用 Map<vaultPath, Uint8Array>，Uint8Array 便于测试直接 `Buffer.from`
// 拼装内容并断言 sha256。目录用一个独立 Set 记录（Obsidian 有单独的
// mkdir 语义；单纯把某个前缀视作目录会让 exists('.../subdir') 语义不清）。

const crypto = require("node:crypto");

function makeFakeAdapter() {
    const files = new Map();
    const dirs = new Set();
    return {
        files,
        dirs,
        async exists(p) { return files.has(p) || dirs.has(p); },
        async readBinary(p) {
            const buf = files.get(p);
            if (!buf) throw new Error(`ENOENT: ${p}`);
            // Return ArrayBuffer (real Obsidian does the same).
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
        async writeBinary(p, ab) {
            files.set(p, new Uint8Array(ab));
            // 维护目录前缀，让后续 exists(dir) 返回 true。
            const idx = p.lastIndexOf("/");
            if (idx > 0) dirs.add(p.slice(0, idx));
        },
        async remove(p) {
            if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
            files.delete(p);
        },
        async mkdir(p) { dirs.add(p); },
        async rmdir(p, recursive) {
            if (!recursive) {
                // Emulate "throw if not empty".
                for (const k of files.keys()) {
                    if (k.startsWith(p + "/")) throw new Error(`ENOTEMPTY: ${p}`);
                }
            } else {
                for (const k of [...files.keys()]) {
                    if (k.startsWith(p + "/")) files.delete(k);
                }
            }
            dirs.delete(p);
        },
    };
}

// Minimal test-only stand-in for Obsidian's parsed embed cache. Integration
// tests in concurrent.test.js use simple wikilinks; parser-specific fixtures
// can override this through `fileCacheResolver`.
function makeWikilinkFileCache(file) {
    const content = file && typeof file.__contents === "string" ? file.__contents : "";
    const embeds = [];
    const re = /!\[\[([^\]\n]+)\]\]/g;
    let match;
    while ((match = re.exec(content)) !== null) {
        embeds.push({
            link: match[1].split("|")[0].trim(),
            original: match[0],
            position: {
                start: { offset: match.index },
                end: { offset: match.index + match[0].length },
            },
        });
    }
    return { embeds };
}

function makeFakePlugin(overrides = {}) {
    const adapter = overrides.adapter || makeFakeAdapter();
    const dataStore = { current: null };
    const plugin = {
        manifest: { id: "resize-pics", dir: ".obsidian/plugins/resize-pics" },
        app: {
            vault: {
                adapter,
                async read(file) { return file.__contents || ""; },
                async modify(file, next) { file.__contents = next; },
                async process(file, fn) {
                    const current = file.__contents || "";
                    const next = fn(current);
                    file.__contents = next;
                    return next;
                },
                getResourcePath(file) { return `app://vault/${file.path}`; },
            },
            metadataCache: {
                getFileCache(file) {
                    if (typeof overrides.fileCacheResolver === "function") {
                        return overrides.fileCacheResolver(file);
                    }
                    return makeWikilinkFileCache(file);
                },
                // Trivial resolver: linkpath is interpreted as a vault path.
                getFirstLinkpathDest(linkpath, _sourcePath) {
                    if (!linkpath) return null;
                    return overrides.linkResolver
                        ? overrides.linkResolver(linkpath)
                        : { path: linkpath, __contents: null };
                },
            },
            workspace: {
                getActiveViewOfType: () => overrides.activeView || null,
            },
        },
        addCommand(spec) { this._command = spec; return spec; },
        addRibbonIcon(_i, _t, cb) { this._ribbonCb = cb; return { setAttribute() {} }; },
        addSettingTab(_tab) { this._settingTab = _tab; },
        removeCommand(_id) { this._command = null; },
        async loadData() { return dataStore.current; },
        async saveData(d) { dataStore.current = JSON.parse(JSON.stringify(d)); },
        // Test hooks.
        _dataStore: dataStore,
    };
    return plugin;
}

function sha256Hex(bytes) {
    const h = crypto.createHash("sha256");
    h.update(Buffer.from(bytes));
    return h.digest("hex");
}

module.exports = { makeFakeAdapter, makeFakePlugin, sha256Hex };

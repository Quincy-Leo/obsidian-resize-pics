/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const { normalizePath, requestUrl } = require("obsidian");

/**
 * Tesseract.js runtime assets that the OCR pipeline needs on disk. Worker-side
 * loads cannot use vault-served `app://` URLs across Obsidian's renderer origin,
 * so the host downloads these files and OCR later loads their local bytes.
 *
 * When versions, names, or asset layout change, update the full entry and its
 * pinned hash together. Existing mismatched files are reported and removed;
 * a later download attempt fetches the replacement.
 */
const TESSERACT_JS_VERSION = "5.1.1";
const TESSERACT_CORE_VERSION = "5.1.1";
const TESSDATA_BASE = "https://tessdata.projectnaptha.com/4.0.0_fast";

// SHA-256 hashes are lowercase hex and pin each asset to a byte-exact build.
// Refresh the hash whenever its URL/version changes; otherwise existing old
// bytes may still pass while fresh downloads fail verification.
const REQUIRED_ASSETS = [
    {
        name: "worker.min.js",
        url: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_JS_VERSION}/dist/worker.min.js`,
        sha256: "aca1229639fc9907d86f96e825955a2b7c5716d17f3bc3acd71f9c7ab66181fc",
    },
    {
        name: "tesseract-core-simd.wasm.js",
        url: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_CORE_VERSION}/tesseract-core-simd.wasm.js`,
        sha256: "63f232c4f7a97b04e52eb940202700b2c6239783a75d0ff0553274fac530cd5c",
    },
    {
        name: "chi_sim.traineddata.gz",
        url: `${TESSDATA_BASE}/chi_sim.traineddata.gz`,
        sha256: "3aa140069a09796b8cb8d3ccd0c052e8ed67f20cddb24b70ffa3344b3b94346b",
    },
    {
        name: "eng.traineddata.gz",
        url: `${TESSDATA_BASE}/eng.traineddata.gz`,
        sha256: "18c1ac52b75e35d44735fb6c2a60acfaf23033524653200738e98f0243edb75b",
    },
];

/**
 * Hex-encoded SHA-256 of an ArrayBuffer / typed-array's bytes. Uses the
 * built-in SubtleCrypto (available in Obsidian's Electron/browser context) so
 * we don't have to bundle a hash library.
 * @param {ArrayBuffer | ArrayBufferView} bytes
 * @returns {Promise<string>}
 */
async function sha256Hex(bytes) {
    const view = ArrayBuffer.isView(bytes)
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    const digest = await crypto.subtle.digest("SHA-256", view);
    const arr = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < arr.length; i++) {
        hex += arr[i].toString(16).padStart(2, "0");
    }
    return hex;
}

const DATA_SUBDIR = "tesseract-data";

/**
 * Manages the on-disk cache of Tesseract.js assets under the plugin's data
 * directory. Owns exactly one folder ({@link DATA_SUBDIR} inside the plugin
 * dir); callers get status, drive downloads, or wipe the cache.
 */
class TesseractDependencyManager {
    /**
     * @param {import("obsidian").Plugin} plugin
     */
    constructor(plugin) {
        this.plugin = plugin;
        // Set while an operation is running so the UI can reflect it and a
        // rapid second request can be rejected without starting duplicate work.
        this.downloading = false;
        this.clearing = false;
        this._operation = null;

        // Keep every manager reachable from the plugin. The OCR detector and
        // settings tab normally share one instance, but independently created
        // consumers can still add more. Registration lets unload cancel every
        // active manager synchronously.
        if (plugin) {
            try {
                if (!(plugin.__resizePicsDependencyManagers instanceof Set)) {
                    plugin.__resizePicsDependencyManagers = new Set();
                }
                plugin.__resizePicsDependencyManagers.add(this);
                if (!plugin.dependencyManager) plugin.dependencyManager = this;
            } catch (_) {
                // A host may expose a frozen plugin object.  The manager still
                // works locally; only the optional lifecycle registration is
                // unavailable in that case.
            }
        }
    }

    get adapter() {
        return this.plugin.app.vault.adapter;
    }

    /**
     * Vault-relative plugin directory as reported by Obsidian
     * (`plugin.manifest.dir`, e.g. `.obsidian/plugins/resize-pics`). We refuse
     * to guess it from other pieces — if Obsidian hasn't populated it we bail
     * out, because writing to a wrong directory could scatter files across the
     * vault.
     */
    get pluginDir() {
        const dir = this.plugin.manifest && this.plugin.manifest.dir;
        if (!dir) {
            throw new Error(
                "resize-pics: plugin.manifest.dir is not set; cannot locate plugin directory.",
            );
        }
        return normalizePath(dir);
    }

    /** Vault-relative directory where dependencies live. */
    get baseDir() {
        return normalizePath(`${this.pluginDir}/${DATA_SUBDIR}`);
    }

    /** Vault-relative path for a single asset. */
    getAssetPath(name) {
        return normalizePath(`${this.baseDir}/${name}`);
    }

    /**
     * Mark the current disk operation cancelled.  This is deliberately
     * synchronous: `Plugin.onunload()` cannot await, and callers must be able
     * to prevent a late network response from writing a file immediately.
     */
    cancel() {
        const operation = this._operation;
        if (operation) operation.cancelled = true;
        // Keep the operation token until its promise reaches finally. New
        // work is then held off while a cancelled network request unwinds,
        // even though the public flags are released synchronously for UI and
        // unload state reporting.
        this.downloading = false;
        this.clearing = false;
    }

    _beginOperation(kind) {
        // Allow one dependency-disk operation at a time. Checking the public
        // flags as well keeps the guard consistent with externally supplied
        // in-progress state.
        if (this._operation || this.downloading || this.clearing) return null;
        if (this.plugin && this.plugin.__resizePicsUnloaded) return null;
        const shared = this.plugin && this.plugin.__resizePicsDependencyOperation;
        if (shared && shared.manager !== this) return null;
        const operation = { kind, cancelled: false };
        this._operation = operation;
        if (this.plugin) {
            this.plugin.__resizePicsDependencyOperation = { manager: this, operation };
        }
        this.downloading = kind === "download";
        this.clearing = kind === "clear";
        return operation;
    }

    _isCancelled(operation) {
        return !operation
            || operation.cancelled
            || Boolean(this.plugin && this.plugin.__resizePicsUnloaded);
    }

    _finishOperation(operation) {
        if (this._operation !== operation) return;
        this._operation = null;
        if (this.plugin) {
            const shared = this.plugin.__resizePicsDependencyOperation;
            if (shared && shared.manager === this && shared.operation === operation) {
                this.plugin.__resizePicsDependencyOperation = null;
            }
        }
        this.downloading = false;
        this.clearing = false;
    }

    /**
     * Check which assets are already on disk. By default each file is also
     * hashed and compared against its pinned SHA-256 — a file that exists
     * but hashes wrong (partial download, corruption, version drift) is
     * reported as missing. Callers don't need a separate "corrupt" state;
     * downloadAll removes that file and reports the failed integrity check.
     *
     * Pass `{verifyHash: false}` to perform a presence-only check. Worker
     * initialization uses it to avoid hashing ~12 MB again; the settings-page
     * probe remains the full integrity check.
     *
     * @param {{ verifyHash?: boolean }} [options]
     * @returns {Promise<{
     *   installed: string[],
     *   missing: string[],
     *   total: number,
     * }>}
     */
    async checkStatus(options) {
        const verifyHash = !options || options.verifyHash !== false;
        // Resolve the base path once — a missing manifest.dir should surface
        // to the caller, not be swallowed by the per-asset try/catch below.
        const base = this.baseDir;
        const installed = [];
        const missing = [];
        for (const asset of REQUIRED_ASSETS) {
            const path = normalizePath(`${base}/${asset.name}`);
            // Any failure along the "exists → read → hash → compare" chain is
            // treated as "asset not present". A fresh install has nothing to
            // read; a corrupt install shouldn't stall the settings page.
            let ok = false;
            try {
                if (await this.adapter.exists(path)) {
                    if (verifyHash) {
                        const bytes = await this.adapter.readBinary(path);
                        const hash = await sha256Hex(bytes);
                        ok = hash === asset.sha256;
                    } else {
                        ok = true;
                    }
                }
            } catch (e) {
                ok = false;
            }
            if (ok) installed.push(asset.name);
            else missing.push(asset.name);
        }
        return { installed, missing, total: REQUIRED_ASSETS.length };
    }

    async ensureDir() {
        try {
            if (!(await this.adapter.exists(this.baseDir))) {
                await this.adapter.mkdir(this.baseDir);
            }
        } catch (e) {
            // `mkdir` on some adapters throws if the dir already exists — treat
            // as best-effort. writeBinary below will surface a real failure.
        }
    }

    /**
     * Walk the required asset list once, validating files already present and
     * downloading only paths that are physically absent. Three cases per asset:
     *
     *   A) file missing → download it, verify hash, write on match.
     *   B) file present + hash matches → skip (idempotent retry).
     *   C) file present + hash wrong (or unreadable) → remove it, mark this
     *      asset as failed, and **do not** re-download in the same batch.
     *
     * Case C deliberately separates cleanup from replacement: this batch
     * removes the untrusted local bytes and reports the integrity failure,
     * while a later user retry enters case A and performs the network fetch.
     * This avoids silently replacing a corrupt file during the same action.
     * Freshly downloaded bytes that fail their pinned hash are likewise
     * discarded rather than written or retried in-loop.
     *
     * @param {(progress: {
     *   current: number,
     *   total: number,
     *   name: string,
     *   phase: "start" | "done" | "skipped" | "fail",
     *   error?: unknown,
     * }) => void} [onProgress]
     * @returns {Promise<{
     *   downloaded: number,
     *   skipped: number,
     *   failed: Array<{ name: string, error: string }>,
     *   cancelled?: boolean,
     * } | null>} null when another dependency operation owns the lock or the
     *   plugin is unloaded.
     */
    async downloadAll(onProgress) {
        const operation = this._beginOperation("download");
        if (!operation) return null;
        const results = { downloaded: 0, skipped: 0, failed: [] };
        try {
            await this.ensureDir();
            if (this._isCancelled(operation)) {
                results.cancelled = true;
                return results;
            }
            const total = REQUIRED_ASSETS.length;
            for (let i = 0; i < REQUIRED_ASSETS.length; i++) {
                if (this._isCancelled(operation)) {
                    results.cancelled = true;
                    return results;
                }
                const asset = REQUIRED_ASSETS[i];
                const path = this.getAssetPath(asset.name);
                const current = i + 1;

                // Case B / C: something's already on disk under this name.
                // Only hash decides which one — never fall through to a
                // silent re-download.
                if (await this.adapter.exists(path)) {
                    if (this._isCancelled(operation)) {
                        results.cancelled = true;
                        return results;
                    }
                    let hashOk = false;
                    try {
                        const bytes = await this.adapter.readBinary(path);
                        if (this._isCancelled(operation)) {
                            results.cancelled = true;
                            return results;
                        }
                        hashOk = (await sha256Hex(bytes)) === asset.sha256;
                    } catch (_) {
                        hashOk = false;
                    }
                    if (this._isCancelled(operation)) {
                        results.cancelled = true;
                        return results;
                    }
                    if (hashOk) {
                        // Case B — good copy already there.
                        results.skipped += 1;
                        onProgress && onProgress({ current, total, name: asset.name, phase: "skipped" });
                        continue;
                    }
                    // Case C — remove the bad file (best-effort) so the
                    // user's next Download click enters case A instead of
                    // C again; mark this asset as failed for this batch.
                    try {
                        await this.adapter.remove(path);
                    } catch (_) { /* ignore */ }
                    results.failed.push({
                        name: asset.name,
                        error: "existing file failed sha256 check; removed",
                    });
                    onProgress && onProgress({ current, total, name: asset.name, phase: "fail" });
                    continue;
                }

                // Case A — nothing on disk, actually fetch.
                onProgress && onProgress({ current, total, name: asset.name, phase: "start" });
                try {
                    const response = await requestUrl({ url: asset.url, method: "GET" });
                    if (this._isCancelled(operation)) {
                        results.cancelled = true;
                        return results;
                    }
                    if (response.status < 200 || response.status >= 300) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const buf = response.arrayBuffer;
                    if (!buf || buf.byteLength === 0) {
                        throw new Error("empty response");
                    }
                    const hash = await sha256Hex(buf);
                    if (this._isCancelled(operation)) {
                        results.cancelled = true;
                        return results;
                    }
                    if (hash !== asset.sha256) {
                        // Downloaded bytes are bad — don't write them.
                        // Nothing to clean up on disk (case A entry means
                        // path didn't exist and we haven't called
                        // writeBinary yet).
                        throw new Error(
                            `sha256 mismatch: expected ${asset.sha256}, got ${hash}`,
                        );
                    }
                    if (this._isCancelled(operation)) {
                        results.cancelled = true;
                        return results;
                    }
                    await this.adapter.writeBinary(path, buf);
                    results.downloaded += 1;
                    onProgress && onProgress({ current, total, name: asset.name, phase: "done" });
                } catch (err) {
                    if (this._isCancelled(operation)) {
                        results.cancelled = true;
                        return results;
                    }
                    const message = err instanceof Error ? err.message : String(err);
                    results.failed.push({ name: asset.name, error: message });
                    onProgress && onProgress({ current, total, name: asset.name, phase: "fail", error: err });
                }
            }
            return results;
        } finally {
            this._finishOperation(operation);
        }
    }

    /**
     * Delete every managed asset from disk. The tesseract-data folder itself
     * is only removed if it ends up empty afterwards (so user-dropped files
     * aren't collateral). Also evicts the tesseract.js IDB cache entries we
     * seeded from {@link ocr.js} — the on-disk copy is authoritative, so any
     * stale IDB copies would just waste renderer storage after a reset.
     *
     * @returns {Promise<{ removed: string[], evictedKeys: string[], cancelled?: boolean } | null>}
     *   null when another dependency operation owns the lock or the plugin is
     *   unloaded.
     */
    async clearCache() {
        const operation = this._beginOperation("clear");
        if (!operation) return null;
        const result = { removed: [], evictedKeys: [] };
        try {
            for (const asset of REQUIRED_ASSETS) {
                if (this._isCancelled(operation)) {
                    result.cancelled = true;
                    return result;
                }
                const path = this.getAssetPath(asset.name);
                if (await this.adapter.exists(path)) {
                    if (this._isCancelled(operation)) {
                        result.cancelled = true;
                        return result;
                    }
                    await this.adapter.remove(path);
                    result.removed.push(asset.name);
                }
            }
            if (this._isCancelled(operation)) {
                result.cancelled = true;
                return result;
            }
            if (await this.adapter.exists(this.baseDir)) {
                if (this._isCancelled(operation)) {
                    result.cancelled = true;
                    return result;
                }
                try {
                    await this.adapter.rmdir(this.baseDir, false);
                } catch (e) {
                    // Folder wasn't empty (user files, symlinks) — leave it.
                }
            }
            // Lazy-require to avoid the ocr <-> tesseractDeps require cycle
            // (ocr.js pulls this file in at module load time).
            try {
                if (this._isCancelled(operation)) {
                    result.cancelled = true;
                    return result;
                }
                const { evictOcrCache } = require("./ocr");
                result.evictedKeys = await evictOcrCache();
            } catch (e) {
                // IDB clean-up is best-effort — the on-disk removal above is
                // the user-visible outcome, and a stuck IDB entry would only
                // waste storage, not misbehave (cacheMethod is "readOnly").
                console.error("resize-pics: failed to evict OCR IDB cache", e);
            }
            return result;
        } finally {
            this._finishOperation(operation);
        }
    }
}

module.exports = {
    TesseractDependencyManager,
};

/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const { createWorker } = require("tesseract.js");
const { localizedError } = require("./settings");
const { TesseractDependencyManager } = require("./tesseractDeps");

// Passed to Tesseract as a `+`-joined string, matching the traineddata
// filenames stored on disk (and used as IDB cache keys below).
const OCR_LANGS = "eng+chi_sim";

// OEM.LSTM_ONLY. Duplicated as a literal so we don't depend on tesseract.js
// re-exporting the constant from the main bundle entry.
const OEM_LSTM_ONLY = 1;

// idb-keyval's defaults, used by tesseract.js's browser cache adapter.
// If a future version bumps these we'd need to bump here too.
const IDB_NAME = "keyval-store";
const IDB_STORE = "keyval";

// Namespace our IDB keys so we don't stomp on other Obsidian plugins that
// also use tesseract.js from the same renderer origin. tesseract.js reads
// and writes traineddata under `${cachePath}/${lang}.traineddata` in the
// shared idb-keyval store; the default cachePath is ".", so bare
// "./eng.traineddata" is exactly the key any other tesseract.js consumer
// would touch. Using a plugin-specific prefix isolates our entries and
// makes them safe to delete on "clear cache" without disturbing anyone.
const CACHE_PATH = "resize-pics";

function cacheKeyForLang(lang) {
    return `${CACHE_PATH}/${lang}.traineddata`;
}

const TRIM_FRACTION = 0.2;

// Discard OCR-detected lines below this confidence. Tesseract reports
// confidence as 0-100 (mean of per-word confidences); values below ~60
// are almost always noise misidentified as text — dashed borders,
// gridlines, JPEG blocking, single-pixel dust. A single 1-px false line
// mixed into a small sample can pull the trimmed mean down enough to
// make the caller enlarge the image an order of magnitude.
const MIN_LINE_CONFIDENCE = 60;

// Ignore line boxes shorter than four pixels; they are not useful text samples.
const MIN_LINE_HEIGHT_PX = 4;

// Require at least two usable lines before their height represents the image.
const MIN_LINES_REQUIRED = 2;

/**
 * Detects the average text height (in CSS pixels at the image's natural
 * size) baked into an image, by running Tesseract.js over it and averaging
 * line bounding-box heights after dropping 20% from each tail.
 *
 * Loading strategy — everything must survive Obsidian's cross-origin
 * boundary. Vault-served resources sit on `app://<vault-uuid>/…` while the
 * plugin runs on `app://obsidian.md`, so a bare `new Worker(app://…)` is
 * rejected with "cannot be accessed from origin 'app://obsidian.md'".
 * Workaround:
 *
 *   1. Read every asset from disk via `adapter.readBinary`.
 *   2. Wrap the worker + core scripts in `blob:` URLs (blob URLs inherit
 *      the creator's origin, so they're same-origin with the renderer).
 *   3. Pre-populate the worker's IndexedDB cache with the traineddata
 *      bytes — a `fetch()` from inside the worker would trip the same
 *      cross-origin rule, so we bypass the network path entirely.
 */
class ImageTextHeightDetector {
    /**
     * @param {import("obsidian").Plugin} plugin
     */
    constructor(plugin) {
        this.plugin = plugin;
        // Keep OCR and the settings page on the same dependency manager when
        // possible.  Besides avoiding duplicate status probes, this exposes a
        // download-in-progress state to the resize command.
        this.deps = (plugin && plugin.dependencyManager)
            || new TesseractDependencyManager(plugin);
        if (plugin && !plugin.dependencyManager) {
            try { plugin.dependencyManager = this.deps; } catch (_) { /* optional */ }
        }
        // Promise resolving to a Tesseract worker, or null before the
        // first call. Kept as a promise so concurrent detect() calls share
        // a single init instead of racing.
        this._workerPromise = null;
        // The promise alone is not enough for lifecycle cleanup: a new worker
        // may be initialized while an older worker is still terminating. Keep
        // the worker and its URLs together as one generation so old cleanup
        // can never revoke resources owned by the new generation.
        this._workerRecord = null;
        this._spawningRecord = null;
        // Blob URLs we minted for the worker + core; kept so terminate()
        // can revokeObjectURL them and not leak the underlying blobs.
        this._blobUrls = [];
        this._urlOwners = new Map();
    }

    /**
     * @param {{tfile: import("obsidian").TFile, resourcePath: string, naturalWidth: number, naturalHeight: number}} info
     *     Loaded image context. Only `resourcePath` is used — the image
     *     bytes are fetched on the main thread (same-origin from the
     *     renderer) and shipped into the worker as an ArrayBuffer.
     * @returns {Promise<number>} Text height in CSS pixels at the image's
     *     natural size, or NaN when fewer than two usable lines are detected.
     */
    async detect(info) {
        if (!this._workerPromise) {
            throw new Error(localizedError(this.plugin.uiText, "ocrDetectBeforeEnsure"));
        }
        const worker = await this._workerPromise;
        // Fetch on the main thread; a worker-side fetch of `app://<uuid>`
        // would fail cross-origin the same way the worker script did.
        const response = await fetch(info.resourcePath);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const { data } = await worker.recognize(bytes, {}, { blocks: true });
        const heights = collectLineHeights(data.lines);
        if (heights.length < MIN_LINES_REQUIRED) return NaN;
        return trimmedMean(heights, TRIM_FRACTION);
    }

    /**
     * Lazily spawns the Tesseract worker on first use and caches the
     * promise. If spawn fails (missing deps, IDB write error, …) the
     * cached slot is cleared so a later call — after the user downloads
     * the assets — will retry from scratch.
     */
    async ensureWorker() {
        if (this._workerRecord) return this._workerRecord.promise;

        const record = {
            promise: null,
            worker: null,
            retired: false,
            urls: new Set(),
        };
        this._workerRecord = record;
        this._spawningRecord = record;
        record.promise = Promise.resolve()
            .then(() => this.spawnWorker(record))
            .then((worker) => {
                record.worker = worker;
                return worker;
            })
            .catch((err) => {
                if (this._workerRecord === record) {
                    this._workerRecord = null;
                    this._workerPromise = null;
                }
                this._revokeRecordUrls(record);
                throw err;
            })
            .finally(() => {
                if (this._spawningRecord === record) this._spawningRecord = null;
            });
        this._workerPromise = record.promise;
        return record.promise;
    }

    /**
     * Build a fresh tesseract.js worker pointed at Blob-URL-wrapped local
     * assets, with the traineddata pre-loaded into the worker's IDB cache.
     */
    async spawnWorker(record) {
        // Skip hashes during worker initialization to avoid rereading ~12 MB.
        // The settings-page status probe is the integrity-checking path; this
        // hot path checks presence, while parse/decode failures still surface
        // from Tesseract initialization.
        const status = await this.deps.checkStatus({ verifyHash: false });
        if (status.missing.length > 0) {
            throw new Error(localizedError(this.plugin.uiText, "ocrDepsMissing", {
                missing: status.missing.length,
                total: status.total,
                names: status.missing.join(", "),
            }));
        }

        const adapter = this.plugin.app.vault.adapter;
        if (typeof adapter.readBinary !== "function") {
            throw new Error(localizedError(this.plugin.uiText, "ocrAdapterMissing"));
        }

        // Read all four binaries in parallel — the biggest is the ~4.5 MB
        // core wasm.js (WASM is inlined as a data URI inside it, so we
        // don't need to fetch the separate .wasm at runtime).
        const [
            workerBytes,
            coreBytes,
            engBytes,
            chiBytes,
        ] = await Promise.all([
            adapter.readBinary(this.deps.getAssetPath("worker.min.js")),
            adapter.readBinary(this.deps.getAssetPath("tesseract-core-simd.wasm.js")),
            adapter.readBinary(this.deps.getAssetPath("eng.traineddata.gz")),
            adapter.readBinary(this.deps.getAssetPath("chi_sim.traineddata.gz")),
        ]);

        // Seed the worker's cache before we spawn it. Keys mirror the
        // path tesseract.js builds from `cachePath` — with our namespaced
        // cachePath they become e.g. "resize-pics/eng.traineddata", so
        // other tesseract.js consumers in the same renderer origin can't
        // collide with (or be clobbered by) our entries. The bytes are
        // still gzipped; the worker detects the 1F 8B magic and gunzips
        // them itself.
        await idbPutAll([
            [cacheKeyForLang("eng"), new Uint8Array(engBytes)],
            [cacheKeyForLang("chi_sim"), new Uint8Array(chiBytes)],
        ]);

        const workerUrl = this._registerBlobUrl(workerBytes, "text/javascript", record);
        // Blob URLs look like `blob:app://obsidian.md/<uuid>` — they don't
        // end in `.js`. tesseract.js checks `corePath.slice(-2) === 'js'`
        // to decide whether the caller supplied a specific file (yes) or
        // a directory (append `/tesseract-core-simd.wasm.js` etc). Appending
        // a `#x.js` fragment makes the string end in `js` while the blob
        // fetch still resolves by the UUID, ignoring the fragment.
        const coreUrl = this._registerBlobUrl(coreBytes, "text/javascript", record) + "#/x.js";

        return createWorker(OCR_LANGS, OEM_LSTM_ONLY, {
            workerPath: workerUrl,
            corePath: coreUrl,
            // Namespace the IDB keys tesseract.js reads to avoid colliding
            // with other Obsidian plugins that also use tesseract.js from
            // the same renderer origin — see {@link CACHE_PATH}. Must match
            // the prefix we used when seeding IDB above.
            cachePath: CACHE_PATH,
            // `workerBlobURL: false` skips tesseract's own blob-wrapper
            // step; we already wrapped the worker in a blob ourselves.
            // With the default wrapper, tesseract would `importScripts()`
            // our URL from inside its own blob — that path is fine, but
            // avoiding the double-wrap makes stack traces readable.
            workerBlobURL: false,
            // Read cache but never write or delete: our on-disk copy is
            // authoritative, and the worker's on-init-failure delete
            // logic (which fires on any Init failure) would erase our
            // pre-populated entries.
            cacheMethod: "readOnly",
            // Downloaded traineddata carries the `.gz` extension. The
            // cache-hit path only uses this flag for the magic-byte
            // check, which is what triggers gunzip.
            gzip: true,
        });
    }

    /**
     * Wrap `bytes` in a Blob of the given MIME type, mint a `blob:` URL,
     * remember it for later revocation, and return the URL.
     */
    _registerBlobUrl(bytes, mimeType, owner) {
        const blob = new Blob([bytes], { type: mimeType });
        const url = URL.createObjectURL(blob);
        this._blobUrls.push(url);
        const record = owner || this._spawningRecord || this._workerRecord;
        if (record && record.retired) {
            // A spawn continuation can finish after its generation was
            // terminated. Do not attach that late URL to a live generation;
            // revoke it immediately instead.
            try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
            this._blobUrls.pop();
        } else if (record) {
            record.urls.add(url);
            this._urlOwners.set(url, record);
        }
        return url;
    }

    _revokeRecordUrls(record) {
        if (!record || !record.urls) return;
        for (const url of record.urls) {
            try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
            this._urlOwners.delete(url);
            const index = this._blobUrls.indexOf(url);
            if (index !== -1) this._blobUrls.splice(index, 1);
        }
        record.urls.clear();
    }

    _revokeBlobUrls() {
        // Fallback cleanup for tracked URLs when no active generation record
        // is available, including repeated terminate() calls after a failure.
        for (const url of [...this._blobUrls]) {
            try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
            this._urlOwners.delete(url);
        }
        this._blobUrls = [];
        if (this._workerRecord && this._workerRecord.urls) {
            this._workerRecord.urls.clear();
        }
    }

    /**
     * Release the underlying worker and any Blob URLs we minted for it.
     * Idempotent — safe to call more than once.
     */
    async terminate() {
        const record = this._workerRecord;
        if (!record) {
            this._workerPromise = null;
            this._revokeBlobUrls();
            return;
        }

        // Detach this generation before awaiting termination.  A concurrent
        // ensureWorker() can now create a fresh record whose URLs are owned by
        // that record alone.
        this._workerRecord = null;
        this._workerPromise = null;
        record.retired = true;
        try {
            try {
                const worker = await record.promise;
                await worker.terminate();
            } catch (e) {
                // Worker never came up cleanly; nothing to terminate.
            }
        } finally {
            this._revokeRecordUrls(record);
        }
    }
}

/**
 * Pull each detected text line's pixel height (`bbox.y1 - bbox.y0`) out of
 * tesseract's flat line list. Line-level is chosen over symbol- or word-
 * level because a line bbox spans top-of-tallest-ascender to
 * bottom-of-lowest-descender, which approximates the font's em height for
 * both Latin and CJK. Symbol bboxes measure ink extent instead — for Latin
 * lowercase that's x-height (~0.5 em), which biases the trimmed mean
 * downward by 30-50 % on mixed CJK/Latin screenshots.
 *
 * Lines whose reported confidence is below {@link MIN_LINE_CONFIDENCE},
 * or whose pixel height is below {@link MIN_LINE_HEIGHT_PX}, are dropped
 * up front — those are the two shapes an OCR false-positive typically
 * takes, and either one is enough to pull the trimmed mean toward 1 px
 * and blow up the caller's scale factor.
 *
 * @param {Array<{bbox?: {x0: number, y0: number, x1: number, y1: number}, confidence?: number}> | undefined} lines
 */
function collectLineHeights(lines) {
    if (!Array.isArray(lines)) return [];
    const heights = [];
    for (const line of lines) {
        if (!line) continue;
        // Tesseract sometimes omits confidence on line records — treat
        // missing as full confidence so we don't discard a legitimate
        // line for lack of a score we never asked for.
        const confidence = Number.isFinite(line.confidence) ? line.confidence : 100;
        if (confidence < MIN_LINE_CONFIDENCE) continue;
        const bbox = line.bbox;
        if (!bbox) continue;
        const h = bbox.y1 - bbox.y0;
        if (!Number.isFinite(h) || h < MIN_LINE_HEIGHT_PX) continue;
        heights.push(h);
    }
    return heights;
}

/**
 * Sort ascending, drop `fraction` from each tail (floor of count), return
 * the arithmetic mean of the middle. Returns NaN if the trimmed slice is
 * empty — the caller treats NaN as "skip this image".
 */
function trimmedMean(values, fraction) {
    const sorted = values.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const drop = Math.floor(n * fraction);
    const start = drop;
    const end = n - drop;
    if (end <= start) return NaN;
    let sum = 0;
    for (let i = start; i < end; i++) sum += sorted[i];
    return sum / (end - start);
}

/**
 * Write a batch of (key, value) pairs to the same `keyval-store`/`keyval`
 * IDB that tesseract.js's browser cache reads from. Mirrors idb-keyval's
 * defaults so we don't have to bundle idb-keyval ourselves. All writes
 * share one transaction so the batch is atomic — either both langs land
 * in the cache or neither does.
 */
function idbPutAll(entries) {
    return new Promise((resolve, reject) => {
        const openReq = indexedDB.open(IDB_NAME);
        openReq.onupgradeneeded = () => {
            // idb-keyval creates the store without options on first open.
            openReq.result.createObjectStore(IDB_STORE);
        };
        openReq.onerror = () => reject(openReq.error);
        openReq.onsuccess = () => {
            const db = openReq.result;
            let tx;
            try {
                tx = db.transaction(IDB_STORE, "readwrite");
            } catch (e) {
                db.close();
                reject(e);
                return;
            }
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
            tx.onabort = () => { db.close(); reject(tx.error); };
            const store = tx.objectStore(IDB_STORE);
            for (const [key, value] of entries) {
                store.put(value, key);
            }
        };
    });
}

/**
 * Delete every IDB entry this plugin has ever written to tesseract.js's
 * shared `keyval-store`/`keyval` store. The `clearCache` button in
 * settings removes the on-disk copies; this function completes the
 * cleanup by evicting the IDB copies too, so a user who uninstalls or
 * resets the plugin doesn't leave stale ~12 MB blobs sitting in the
 * renderer's IndexedDB forever. Keys are scoped under {@link CACHE_PATH},
 * so we can safely enumerate-and-filter without touching entries owned
 * by other tesseract.js users in the same origin.
 *
 * Resolves with the list of deleted keys. If the DB or store doesn't
 * exist yet (fresh install that never seeded), resolves to an empty
 * array without creating them.
 *
 * @returns {Promise<string[]>}
 */
function evictOcrCache() {
    return new Promise((resolve, reject) => {
        // `open` with no version creates the DB at whatever version is
        // current; if none exists, it creates one at version 1. We don't
        // want a bare "clear" to leave a new DB behind, so mark a fresh open
        // as "nothing to do", then close and delete the database on success.
        const openReq = indexedDB.open(IDB_NAME);
        let createdFresh = false;
        openReq.onupgradeneeded = () => {
            createdFresh = true;
        };
        openReq.onerror = () => reject(openReq.error);
        openReq.onsuccess = () => {
            const db = openReq.result;
            if (createdFresh || !db.objectStoreNames.contains(IDB_STORE)) {
                db.close();
                // If we accidentally created the DB, drop it so we don't
                // leave a phantom `keyval-store` behind.
                if (createdFresh) {
                    try { indexedDB.deleteDatabase(IDB_NAME); } catch (_) { /* ignore */ }
                }
                resolve([]);
                return;
            }
            let tx;
            try {
                tx = db.transaction(IDB_STORE, "readwrite");
            } catch (e) {
                db.close();
                reject(e);
                return;
            }
            const store = tx.objectStore(IDB_STORE);
            const removed = [];
            // Walk every key with a cursor and delete the ones under our
            // namespace. Cheaper and more correct than a hard-coded list —
            // if the language set ever changes we don't need to keep this
            // deletion in sync.
            const cursorReq = store.openKeyCursor();
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor) return;
                const key = cursor.key;
                if (typeof key === "string" && key.startsWith(`${CACHE_PATH}/`)) {
                    removed.push(key);
                    cursor.delete();
                }
                cursor.continue();
            };
            tx.oncomplete = () => { db.close(); resolve(removed); };
            tx.onerror = () => { db.close(); reject(tx.error); };
            tx.onabort = () => { db.close(); reject(tx.error); };
        };
    });
}

module.exports = {
    ImageTextHeightDetector,
    evictOcrCache,
};

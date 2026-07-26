/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const { requestUrl } = require("obsidian");
const { localizedError } = require("./settings");
const { ImageTextHeightDetector } = require("./ocr");

const CONTENT_ROOT_SELECTORS = [".markdown-preview-view", ".cm-content"];

// Obsidian's size syntax: `WIDTH` or `WIDTHxHEIGHT` (integers).
//   matches: "386", "386x200", "  42  "     mismatches: "abc", "3.5", "386x", ""
const SIZE_SEGMENT_RE = /^\s*\d+(?:x\d+)?\s*$/;

// Only rewrite references that point at an image file. This is the wide
// filter that separates image links from note links; tesseract.js can decode
// only a subset of these (see OCR_SUPPORTED_EXT_RE), and images that fall in
// this set but not that one are counted as skipped rather than attempted.
//   matches: "foo.png", "bar.JPG", "diagrams/x.svg"    mismatches: "note.md", "a.png.bak"
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?)$/i;

// Formats tesseract.js decodes: bmp, jpg, png, pbm, and webp. The broad image
// filter above currently excludes pbm, so reachable OCR candidates are bmp,
// jpg, png, and webp. Other image formats are counted as skipped before they
// can throw in or stall the worker.
//   matches: "foo.png", "bar.JPG", "diagrams/x.webp"    mismatches: "anim.gif", "vector.svg", "shot.tiff"
const OCR_SUPPORTED_EXT_RE = /\.(png|jpe?g|webp|bmp|pbm)$/i;

// URI schemes we don't try to read as vault files.
//   matches: "https://x.com/a.png", "http://…", "file://…", "data:image/…"
//   mismatches: "foo.png", "sub/foo.png"
const EXTERNAL_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// The narrow slice of external URLs we CAN download over the network — anchored
// at http/https only, per EXTERNAL_IMAGES_NOTES.md's rule: file://, app://,
// data: and other schemes are silently skipped.
const EXTERNAL_HTTPS_RE = /^https?:\/\//i;

// Standard-form external image reference: `![alt](https?://url "optional title")`.
// Kept intentionally simple — nested `[]` in alt, escaped `\]`, and parenthesised
// URLs are not matched. EXTERNAL_IMAGES_NOTES.md explicitly documents this as
// "safely skip on doubt": external images in the wild almost never contain those.
const EXTERNAL_STANDARD_IMAGE_RE = /!\[([^\]\n]*)\]\((https?:\/\/[^\s()]+)(?:\s+"[^"]*")?\)/gi;

// SectionCache.type values that can legitimately contain body-level Markdown
// image syntax. Everything else (`yaml`, `code`, `html`, `comment`, `heading`,
// `thematicBreak`, …) is out of scope — scanning them would false-positive on
// literal `![alt](...)` strings inside frontmatter, fenced code, or comments.
const SAFE_SECTION_TYPES = new Set(["paragraph", "list", "blockquote", "callout"]);

// Inline `` `…` `` spans inside a paragraph must NOT be scanned — a code
// example like `` `![](https://real-url/x.png)` `` would otherwise be picked
// up. We mask them out with equal-length spaces so match offsets stay aligned
// with the original slice. Multi-line and fenced code blocks are already
// excluded via SAFE_SECTION_TYPES.
const INLINE_CODE_SPAN_RE = /`+[^`\n]*?`+/g;

// External image download retries. Each attempt calls `requestUrl` once; on
// non-2xx / empty body / thrown error, wait EXTERNAL_FETCH_BACKOFF_MS × attempt
// before the next attempt. Three attempts × 200 ms linear backoff bounds the
// worst-case wall clock at ~600 ms of sleep for a single failed image.
const EXTERNAL_FETCH_MAX_ATTEMPTS = 3;
const EXTERNAL_FETCH_BACKOFF_MS = 200;

// Cancellation-aware sleep granularity. The sleep chunk is small so that a
// user cancel is observed at ~50 ms latency even when a full backoff is in
// flight.
const CANCEL_POLL_MS = 50;

// Symmetric sanity clamp on bodyFontPx / imageTextHeightPx: refuse to
// resize when the ratio is more than this many × away from 1 in either
// direction (i.e. accept scale ∈ [1/MAX_SCALE_RATIO, MAX_SCALE_RATIO]).
const MAX_SCALE_RATIO = 10;

/**
 * Get the body font size (in CSS pixels) of the note's content area.
 *
 * Reads the computed `font-size` of the first content root that exists in the
 * view (reading view first, then Live Preview / source). Throws if no root is
 * found or the computed value is not a positive finite number — the caller
 * should surface that error instead of guessing.
 *
 * @param {HTMLElement} containerEl A MarkdownView's containerEl.
 * @param {{ error: Record<string, string> }} uiText Current-locale strings
 *     from `plugin.uiText`. Threaded in so error messages match the user's
 *     chosen UI language rather than being emitted in every supported
 *     locale at once.
 * @returns {number} Font size in CSS pixels.
 */
function getBodyFontSizePx(containerEl, uiText) {
    const root = containerEl
        && CONTENT_ROOT_SELECTORS
            .map((selector) => containerEl.querySelector(selector))
            .find((node) => node !== null && node !== undefined);
    if (!root) {
        throw new Error(localizedError(uiText, "noContentRoot"));
    }
    const fontSize = parseFloat(getComputedStyle(root).fontSize);
    if (!Number.isFinite(fontSize) || fontSize <= 0) {
        throw new Error(localizedError(uiText, "invalidFontSize"));
    }
    return fontSize;
}

/**
 * Load an image URL and resolve to its natural pixel dimensions.
 * @param {string} url
 * @returns {Promise<{naturalWidth: number, naturalHeight: number} | null>}
 */
function loadImageDimensions(url) {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
        });
        image.onerror = () => resolve(null);
        image.src = url;
    });
}

/**
 * Same as {@link loadImageDimensions} but starting from already-downloaded
 * bytes rather than a URL Obsidian can serve. Used for external images we
 * fetched over the network — we mint a short-lived `blob:` URL so `<img>`
 * can decode the bytes locally, then revoke it once decoding is done.
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {Promise<{naturalWidth: number, naturalHeight: number} | null>}
 */
async function loadImageDimensionsFromBytes(bytes) {
    const view = ArrayBuffer.isView(bytes)
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    const blob = new Blob([view]);
    const url = URL.createObjectURL(blob);
    try {
        return await loadImageDimensions(url);
    } finally {
        // Revocation must happen after `<img>` has decoded (which the
        // await above guarantees) — earlier revocation would race the
        // decode. Guard against test stubs that may not have revokeObjectURL.
        try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    }
}

/**
 * Sleep for at most `ms` milliseconds, waking up every {@link CANCEL_POLL_MS}
 * to give `isCancelled()` a chance to short-circuit. Callers must still
 * re-check cancellation after awaiting because the sleep is best-effort.
 * @param {number} ms
 * @param {() => boolean} isCancelled
 */
async function sleepCancellable(ms, isCancelled) {
    if (ms <= 0) return;
    let remaining = ms;
    while (remaining > 0) {
        if (isCancelled && isCancelled()) return;
        const chunk = Math.min(CANCEL_POLL_MS, remaining);
        await new Promise((resolve) => setTimeout(resolve, chunk));
        remaining -= chunk;
    }
}

/**
 * Pull the `pathname` out of an http(s) URL so callers can test extensions
 * against `.png` etc. without confusing query strings or fragments. Falls
 * back to a manual strip when `new URL()` can't parse (e.g. non-standard
 * hosts). Returns the input verbatim on unrecoverable parse failure so an
 * extension check on the result will simply reject the URL.
 * @param {string} url
 * @returns {string}
 */
function urlPathnameFor(url) {
    try {
        return new URL(url).pathname;
    } catch (_) {
        return url.split("#")[0].split("?")[0];
    }
}

/**
 * Fetch an external image over the network with a bounded retry budget. Each
 * attempt uses Obsidian's `requestUrl` (which bypasses the renderer's CORS
 * enforcement) with `throw: false`, so we can inspect non-2xx statuses without
 * a try/catch. Between failed attempts we wait a short linear backoff so a
 * flaky server or transient DNS blip doesn't burn the whole retry budget in
 * milliseconds.
 *
 * Cancellation: `isCancelled()` is polled before every network call, after
 * each response, and inside the sleep between attempts. On a positive result
 * the function returns `null` immediately so the caller can propagate the
 * cancelled result upward.
 *
 * @param {string} url — Raw https URL, NOT decodeURIComponent'd (percent-
 *     escaped bytes in the path must survive verbatim into the request).
 * @param {() => boolean} isCancelled
 * @param {number} backoffMs — Delay between attempts × attempt-number. Tests
 *     pass 0 to keep retry tests instantaneous.
 * @returns {Promise<Uint8Array | null>} Bytes on success; `null` on cancel.
 * @throws Error containing the final HTTP status or network error message
 *     when all attempts fail without cancellation.
 */
async function fetchExternalImageBytes(url, isCancelled, backoffMs) {
    const cancel = isCancelled || (() => false);
    let lastError = null;
    for (let attempt = 1; attempt <= EXTERNAL_FETCH_MAX_ATTEMPTS; attempt++) {
        if (cancel()) return null;
        let response = null;
        try {
            response = await requestUrl({ url, method: "GET", throw: false });
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            response = null;
        }
        if (cancel()) return null;
        if (response
            && Number.isFinite(response.status)
            && response.status >= 200
            && response.status < 300
            && response.arrayBuffer
            && response.arrayBuffer.byteLength > 0) {
            return new Uint8Array(response.arrayBuffer);
        }
        if (response) {
            const status = Number.isFinite(response.status) ? response.status : "?";
            const emptyBody = response.status >= 200
                && response.status < 300
                && (!response.arrayBuffer || response.arrayBuffer.byteLength === 0);
            lastError = emptyBody
                ? new Error("empty response body")
                : new Error(`HTTP ${status}`);
        }
        if (attempt < EXTERNAL_FETCH_MAX_ATTEMPTS) {
            const wait = (backoffMs !== undefined ? backoffMs : EXTERNAL_FETCH_BACKOFF_MS)
                * attempt;
            await sleepCancellable(wait, cancel);
            if (cancel()) return null;
        }
    }
    throw lastError || new Error("external image fetch failed");
}

/** Decode a cached embed link into a vault linkpath (best effort). */
function urlToLinkpath(url) {
    const trimmed = url.trim().replace(/^<|>$/g, "");
    const withoutHash = trimmed.split("#")[0];
    try { return decodeURIComponent(withoutHash); } catch { return withoutHash; }
}

/**
 * Set (or replace) the size segment inside a pipe-separated segment list.
 * Obsidian recognises the LAST size-shaped segment as the size, so we replace
 * the last matching one; otherwise we append.
 */
function applySizeToSegments(segments, newWidth) {
    for (let i = segments.length - 1; i >= 0; i--) {
        if (SIZE_SEGMENT_RE.test(segments[i])) {
            const next = segments.slice();
            next[i] = String(newWidth);
            return next;
        }
    }
    return segments.concat([String(newWidth)]);
}

/** Rewrite `![[path|...]]` — path preserved, size segment set/updated. */
function rewriteWikilinkInner(inner, newWidth) {
    const parts = inner.split("|");
    const linkpath = parts[0];
    const suffix = applySizeToSegments(parts.slice(1), newWidth);
    return suffix.length > 0 ? `${linkpath}|${suffix.join("|")}` : linkpath;
}

/**
 * Rewrite the alt portion of `![alt](url)`. Empty alt is replaced with the
 * size; otherwise the size is applied to the pipe-separated segments in alt.
 */
function rewriteStandardAlt(alt, newWidth) {
    if (alt === "") return String(newWidth);
    const segments = applySizeToSegments(alt.split("|"), newWidth);
    return segments.join("|");
}

/**
 * Find the closing bracket of a standard Markdown image's alt text.
 * Nested and escaped brackets are allowed by Markdown link labels.
 */
function findStandardAltEnd(original) {
    if (!original.startsWith("![")) return -1;

    let depth = 1;
    for (let i = 2; i < original.length; i++) {
        if (original[i] === "\\") {
            i += 1;
            continue;
        }
        if (original[i] === "[") {
            depth += 1;
            continue;
        }
        if (original[i] !== "]") continue;

        depth -= 1;
        if (depth === 0) {
            return original[i + 1] === "(" ? i : -1;
        }
    }
    return -1;
}

/**
 * Convert Obsidian metadata-cache embeds into validated source edits.
 *
 * `CachedMetadata.embeds` is produced by Obsidian's Markdown parser, so it
 * contains actual embed nodes rather than Markdown-looking text found in
 * frontmatter, code, or comments. Never fall back to scanning the full note:
 * a missing or stale cache must result in a safe skip, not a speculative edit.
 */
function collectImageReferences(content, embeds) {
    if (!Array.isArray(embeds)) return [];

    const edits = [];
    for (const embed of embeds) {
        const position = embed && embed.position;
        const start = position && position.start && position.start.offset;
        const end = position && position.end && position.end.offset;
        const original = embed && embed.original;
        const link = embed && embed.link;

        if (!Number.isInteger(start) || !Number.isInteger(end)
            || start < 0 || end <= start || end > content.length
            || typeof original !== "string" || typeof link !== "string"
            || content.slice(start, end) !== original) {
            continue;
        }

        if (original.startsWith("![[") && original.endsWith("]]")) {
            edits.push({
                kind: "wikilink",
                start,
                end,
                inner: original.slice(3, -2),
                link,
            });
            continue;
        }

        const altEnd = findStandardAltEnd(original);
        if (altEnd !== -1) {
            edits.push({
                kind: "standard",
                start,
                end,
                original,
                alt: original.slice(2, altEnd),
                altEnd,
                link,
            });
        }
    }

    // Splice from the end so earlier offsets stay valid.
    edits.sort((a, b) => b.start - a.start);

    // Parser output should never overlap, but rejecting overlaps keeps a
    // malformed or concurrently-changing cache from corrupting source text.
    const nonOverlapping = [];
    let nextStart = content.length;
    for (const edit of edits) {
        if (edit.end > nextStart) continue;
        nonOverlapping.push(edit);
        nextStart = edit.start;
    }
    return nonOverlapping;
}

/**
 * Discover standard-form external image references (`![alt](https?://…)`) by
 * scanning only body-level sections that Obsidian's parser marks as scannable.
 * External images do NOT appear in `metadataCache.embeds` or `.links`, so we
 * can't reuse the embed-cache path here; but we still refuse to scan the raw
 * content string because frontmatter, fenced code, comments, and raw HTML all
 * commonly contain literal `![alt](…)` strings that mustn't be rewritten.
 *
 * Inline backtick spans inside a paragraph are masked out with equal-length
 * spaces so match offsets stay aligned with the original slice — Markdown
 * documentation like `` `![alt](https://…)` `` should never be edited.
 *
 * @param {string} content
 * @param {import("obsidian").SectionCache[] | undefined} sections
 * @returns {Array<{
 *   kind: "standard",
 *   external: true,
 *   start: number,
 *   end: number,
 *   original: string,
 *   alt: string,
 *   altEnd: number,
 *   link: string,
 * }>}
 */
function collectExternalImageReferences(content, sections) {
    if (!Array.isArray(sections)) return [];
    const edits = [];
    for (const section of sections) {
        const type = section && section.type;
        if (!SAFE_SECTION_TYPES.has(type)) continue;
        const position = section && section.position;
        const start = position && position.start && position.start.offset;
        const end = position && position.end && position.end.offset;
        if (!Number.isInteger(start) || !Number.isInteger(end)
            || start < 0 || end <= start || end > content.length) {
            continue;
        }
        const slice = content.slice(start, end);
        // Mask inline-code spans with equal-length spaces so match offsets
        // still line up with `slice` (and therefore with `content` once we
        // add `start`).
        const masked = slice.replace(INLINE_CODE_SPAN_RE, (m) => " ".repeat(m.length));
        // matchAll is safe: EXTERNAL_STANDARD_IMAGE_RE has the /g flag.
        for (const match of masked.matchAll(EXTERNAL_STANDARD_IMAGE_RE)) {
            const matchStart = start + match.index;
            const matchEnd = matchStart + match[0].length;
            // Recover the ACTUAL text at those offsets from the unmasked
            // content — the masking step only affects search boundaries,
            // not the string we ultimately splice back in.
            const original = content.slice(matchStart, matchEnd);
            if (original !== match[0]) continue;
            const altEnd = findStandardAltEnd(original);
            if (altEnd === -1) continue;
            edits.push({
                kind: "standard",
                external: true,
                start: matchStart,
                end: matchEnd,
                original,
                alt: original.slice(2, altEnd),
                altEnd,
                link: match[2],
            });
        }
    }
    return edits;
}

/**
 * Merge parser-confirmed local edits with section-scanned external edits into
 * a single, sorted, non-overlapping list ordered by descending `start` so the
 * caller can splice edits from the end without invalidating earlier offsets.
 *
 * @param {string} content
 * @param {import("obsidian").EmbedCache[] | undefined} embeds
 * @param {import("obsidian").SectionCache[] | undefined} sections
 */
function collectAllImageReferences(content, embeds, sections) {
    const localEdits = collectImageReferences(content, embeds);
    const externalEdits = collectExternalImageReferences(content, sections);
    if (externalEdits.length === 0) return localEdits;
    const merged = localEdits.concat(externalEdits);
    // Sort DESC by start so the splice loop can walk from the end.
    merged.sort((a, b) => b.start - a.start);
    // Guard against overlapping ranges (never expected between the two
    // sources, but a stale cache or racing parser could produce them).
    const nonOverlapping = [];
    let nextStart = content.length;
    for (const edit of merged) {
        if (edit.end > nextStart) continue;
        nonOverlapping.push(edit);
        nextStart = edit.start;
    }
    return nonOverlapping;
}

/**
 * Encapsulates the "resize images in a note's Markdown syntax" job.
 * The image files themselves are never modified.
 */
class ResizeImagesJob {
    /**
     * @param {import("obsidian").Plugin} plugin
     */
    constructor(plugin) {
        this.plugin = plugin;
        this.app = plugin.app;
        this.imageTextHeightDetector = new ImageTextHeightDetector(plugin);
        this._cancelGeneration = 0;
        // Backoff between external-image retry attempts. Exposed as a
        // per-instance field so tests can set it to 0 without hard-coding
        // that fast path into the production retry helper.
        this._externalFetchBackoffMs = EXTERNAL_FETCH_BACKOFF_MS;
    }

    /**
     * Invalidate the current run synchronously. A subsequent run captures the
     * updated generation, so clearing the OCR cache does not permanently
     * disable the job.
     */
    cancel() {
        this._cancelGeneration += 1;
    }

    _newRunToken() {
        return {
            jobGeneration: this._cancelGeneration,
            pluginGeneration: this.plugin && this.plugin._lifecycleGeneration,
        };
    }

    _isCancelled(token) {
        if (!token) return false;
        if (token.jobGeneration !== this._cancelGeneration) return true;
        if (this.plugin && this.plugin.__resizePicsUnloaded) return true;
        return token.pluginGeneration !== undefined
            && this.plugin
            && this.plugin._lifecycleGeneration !== token.pluginGeneration;
    }

    _cancelledResult(stats) {
        return {
            considered: stats.considered || 0,
            resized: stats.resized || 0,
            skipped: stats.skipped || 0,
            aborted: true,
            cancelled: true,
        };
    }

    /** Release OCR resources; safe to call more than once. */
    async dispose() {
        this.cancel();
        if (this.imageTextHeightDetector) {
            await this.imageTextHeightDetector.terminate();
        }
    }

    /**
     * Run the resize over an active MarkdownView.
     *
     *   newWidth = round(naturalWidth * bodyFontPx / imageTextHeightPx)
     *
     * @param {import("obsidian").MarkdownView} view
     * @returns {Promise<{
     *     considered: number,
     *     resized: number,
     *     skipped: number,
     *     aborted: boolean,
     *     cancelled?: boolean,
     * }>}
     */
    async run(view) {
        const token = this._newRunToken();
        if (this._isCancelled(token)) return this._cancelledResult({});
        if (!view || !view.file) {
            throw new Error(localizedError(this.plugin.uiText, "noActiveFile"));
        }

        const vault = this.app && this.app.vault;
        if (!vault || typeof vault.process !== "function") {
            throw new Error(localizedError(this.plugin.uiText, "atomicProcessUnavailable"));
        }

        const bodyFontPx = getBodyFontSizePx(view.containerEl, this.plugin.uiText);
        if (this._isCancelled(token)) return this._cancelledResult({});
        const original = await vault.read(view.file);
        if (this._isCancelled(token)) return this._cancelledResult({});
        const cache = this.app.metadataCache.getFileCache(view.file);
        const embeds = cache && cache.embeds;
        const sections = cache && cache.sections;
        const {
            newContent,
            resized,
            skipped,
            considered,
            aborted: rewriteAborted,
            cancelled: rewriteCancelled,
        } = await this.rewriteContent(
            original, view.file.path, bodyFontPx, embeds, sections, token,
        );

        if (rewriteAborted || rewriteCancelled || this._isCancelled(token)) {
            return this._cancelledResult({ considered, resized, skipped });
        }

        if (newContent !== original) {
            if (this._isCancelled(token)) {
                return this._cancelledResult({ considered, resized, skipped });
            }

            let accepted = false;
            let conflict = false;
            await vault.process(view.file, (current) => {
                if (this._isCancelled(token)) return current;
                if (current !== original) {
                    conflict = true;
                    return current;
                }
                accepted = true;
                return newContent;
            });
            if (this._isCancelled(token)) {
                return this._cancelledResult({ considered, resized, skipped });
            }
            if (!accepted || conflict) return { considered, resized, skipped, aborted: true };

            // vault.process fires a `modify` event, but for tiny source-only
            // changes like a width segment (`|500` → `|1000`) both reading
            // view and Live Preview commonly keep the existing <img> element
            // and skip re-running the size rules, so the new width doesn't
            // reach the DOM until the user switches modes or reopens the
            // file. Force a leaf rebuild so the new size takes effect in
            // whatever mode the view is currently in. Guarded because
            // rebuildView is undocumented API and any failure here must not
            // turn a successful write into a reported failure.
            if (view.leaf && typeof view.leaf.rebuildView === "function") {
                try {
                    view.leaf.rebuildView();
                } catch (error) {
                    console.error("resize-pics: rebuildView failed after resize", error);
                }
            }
        }

        return { considered, resized, skipped, aborted: false };
    }

    /**
     * Build source edits from parser-confirmed embed positions plus
     * section-scanned external references, resolving and measuring each
     * image (locally from the vault or by downloading over the network for
     * https URLs) before returning rewritten content plus counters. Public
     * so it can be unit-tested independently of a view.
     *
     * External URLs live outside `metadataCache.embeds`, so `sections`
     * (from `CachedMetadata.sections`) is what constrains external
     * discovery to safe body regions — see EXTERNAL_IMAGES_NOTES.md.
     *
     * @param {string} content
     * @param {string} sourcePath
     * @param {number} bodyFontPx
     * @param {import("obsidian").EmbedCache[] | undefined} embeds
     * @param {import("obsidian").SectionCache[] | undefined} [sections]
     *     Undefined at legacy 4-arg call sites; external discovery
     *     safely no-ops when absent (never falls back to scanning
     *     the raw content string).
     * @param {object} [token]
     */
    async rewriteContent(content, sourcePath, bodyFontPx, embeds, sections, token) {
        // Backward-compat: legacy 4-arg / 5-arg-with-token call sites
        // (existing unit tests) passed `token` in the `sections` position.
        // Detect and shift it back so those calls keep working.
        if (token === undefined && sections !== undefined
            && !Array.isArray(sections)
            && typeof sections === "object"
            && ("jobGeneration" in sections || "pluginGeneration" in sections)) {
            token = sections;
            sections = undefined;
        }
        const edits = collectAllImageReferences(content, embeds, sections);
        let result = content;
        let resized = 0;
        let skipped = 0;
        let considered = 0;
        // The first time we're about to run OCR we explicitly bring the
        // worker up. Errors from ensureWorker() (deps missing, adapter
        // can't read plugin dir, worker init failure) are GLOBAL — they
        // affect every image the same way, so they must reach the
        // top-level Notice in main.js instead of being silently absorbed
        // by the per-image `try/catch` below and counted as N × skipped.
        // Kept lazy so a note with no OCR-supported images doesn't spin
        // up ~12 MB of traineddata for nothing.
        let workerReady = false;

        for (const edit of edits) {
            if (this._isCancelled(token)) {
                return {
                    newContent: result,
                    resized,
                    skipped,
                    considered,
                    aborted: true,
                    cancelled: true,
                };
            }
            const isExternal = Boolean(edit.external);

            // -------- Resolve to {resourcePath | bytes, dims} --------
            let tfile = null;
            let resourcePath = null;
            let externalBytes = null;
            let dims = null;
            let rawLinkpath = "";

            if (isExternal) {
                // Preserve the URL verbatim so percent-encoded bytes reach
                // the server unchanged. Do NOT decodeURIComponent here.
                const fetchUrl = String(edit.link).trim();
                rawLinkpath = fetchUrl;
                const pathForExt = urlPathnameFor(fetchUrl);
                if (!IMAGE_EXT_RE.test(pathForExt)) continue;
                considered += 1;
                if (!OCR_SUPPORTED_EXT_RE.test(pathForExt)) {
                    skipped += 1;
                    continue;
                }
                let bytes;
                try {
                    bytes = await fetchExternalImageBytes(
                        fetchUrl,
                        () => this._isCancelled(token),
                        this._externalFetchBackoffMs,
                    );
                } catch (err) {
                    if (this._isCancelled(token)) {
                        return {
                            newContent: result,
                            resized,
                            skipped,
                            considered,
                            aborted: true,
                            cancelled: true,
                        };
                    }
                    console.error(
                        "resize-pics: failed to fetch external image",
                        fetchUrl, err,
                    );
                    skipped += 1;
                    continue;
                }
                if (this._isCancelled(token)) {
                    return {
                        newContent: result,
                        resized,
                        skipped,
                        considered,
                        aborted: true,
                        cancelled: true,
                    };
                }
                if (bytes === null) {
                    // fetchExternalImageBytes returns null only on cancel.
                    return {
                        newContent: result,
                        resized,
                        skipped,
                        considered,
                        aborted: true,
                        cancelled: true,
                    };
                }
                dims = await loadImageDimensionsFromBytes(bytes);
                if (this._isCancelled(token)) {
                    return {
                        newContent: result,
                        resized,
                        skipped,
                        considered,
                        aborted: true,
                        cancelled: true,
                    };
                }
                if (!dims || !dims.naturalWidth) { skipped += 1; continue; }
                externalBytes = bytes;
            } else {
                rawLinkpath = urlToLinkpath(edit.link);
                // Local branch: unresolved link or other-scheme URI (file://,
                // app://, data:, …) is silently skipped, not counted.
                if (!rawLinkpath || EXTERNAL_URL_RE.test(rawLinkpath)) continue;
                if (!IMAGE_EXT_RE.test(rawLinkpath)) continue;
                considered += 1;
                if (!OCR_SUPPORTED_EXT_RE.test(rawLinkpath)) {
                    skipped += 1;
                    continue;
                }
                tfile = this.app.metadataCache.getFirstLinkpathDest(rawLinkpath, sourcePath);
                if (!tfile) { skipped += 1; continue; }
                resourcePath = this.app.vault.getResourcePath(tfile);
                dims = await loadImageDimensions(resourcePath);
                if (!dims || !dims.naturalWidth) { skipped += 1; continue; }
                if (this._isCancelled(token)) {
                    return {
                        newContent: result,
                        resized,
                        skipped,
                        considered,
                        aborted: true,
                        cancelled: true,
                    };
                }
            }

            // Bring the OCR worker up on the first image that would
            // actually use it. Do NOT wrap in try/catch — see workerReady
            // declaration above for why global failures must propagate.
            if (!workerReady) {
                try {
                    await this.imageTextHeightDetector.ensureWorker();
                } catch (err) {
                    if (this._isCancelled(token)) {
                        return {
                            newContent: result,
                            resized,
                            skipped,
                            considered,
                            aborted: true,
                            cancelled: true,
                        };
                    }
                    throw err;
                }
                workerReady = true;
            }

            if (this._isCancelled(token)) {
                return {
                    newContent: result,
                    resized,
                    skipped,
                    considered,
                    aborted: true,
                    cancelled: true,
                };
            }

            // A single corrupt/oversize/decoder-hostile image must not
            // terminate the whole batch — catch here and count the failure.
            // At this point the worker is known-good, so any error is
            // legitimately per-image (bad bytes, timeout, decoder reject).
            let imageTextHeightPx;
            try {
                imageTextHeightPx = await this.imageTextHeightDetector.detect({
                    tfile,
                    resourcePath,
                    // Pre-fetched bytes for external images; detect() will
                    // ship these into the worker instead of re-fetching.
                    // For local images this is null and OCR falls back to
                    // its main-thread fetch(resourcePath) path.
                    bytes: externalBytes,
                    naturalWidth: dims.naturalWidth,
                    naturalHeight: dims.naturalHeight,
                });
            } catch (err) {
                if (this._isCancelled(token)) {
                    return {
                        newContent: result,
                        resized,
                        skipped,
                        considered,
                        aborted: true,
                        cancelled: true,
                    };
                }
                console.error("resize-pics: OCR failed for", rawLinkpath, err);
                skipped += 1;
                continue;
            }

            if (!Number.isFinite(imageTextHeightPx) || imageTextHeightPx <= 0) {
                skipped += 1;
                continue;
            }

            const scale = bodyFontPx / imageTextHeightPx;
            if (!Number.isFinite(scale) || scale < 1 / MAX_SCALE_RATIO || scale > MAX_SCALE_RATIO) {
                skipped += 1;
                continue;
            }
            const newWidth = Math.max(1, Math.round(dims.naturalWidth * scale));

            const replacement = edit.kind === "wikilink"
                ? `![[${rewriteWikilinkInner(edit.inner, newWidth)}]]`
                : `${edit.original.slice(0, 2)}${rewriteStandardAlt(edit.alt, newWidth)}`
                    + edit.original.slice(edit.altEnd);

            result = result.substring(0, edit.start) + replacement + result.substring(edit.end);
            resized += 1;
        }

        return { newContent: result, resized, skipped, considered };
    }
}

module.exports = {
    ResizeImagesJob,
};

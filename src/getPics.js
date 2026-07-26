/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

// ---------------------------------------------------------------------------
// getPics.js — image discovery + fetching, kept out of the resize pipeline
// ---------------------------------------------------------------------------
//
// This module answers a single question: "given a note's Markdown, which
// images live in it and how do I get their bytes + natural dimensions?"
// It knows about Obsidian's `metadataCache` (embeds & sections), the two
// on-vault + one over-network sourcing paths, and the retry/cancel discipline
// they all share. It knows NOTHING about OCR, scale factors, or how the
// resulting size ends up back in the source string.
//
// The resize job at src/resize.js owns those concerns and drives this
// module through the {@link PicSource} class exported below.

const { requestUrl } = require("obsidian");

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
// See EXTERNAL_IMAGES_NOTES.md:57-73.
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

// ---------------------------------------------------------------------------
// Helpers — dimension loading, cancellable sleep, URL utilities
// ---------------------------------------------------------------------------

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

/** Decode a cached embed link into a vault linkpath (best effort). */
function urlToLinkpath(url) {
    const trimmed = url.trim().replace(/^<|>$/g, "");
    const withoutHash = trimmed.split("#")[0];
    try { return decodeURIComponent(withoutHash); } catch { return withoutHash; }
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

// ---------------------------------------------------------------------------
// Discovery — turn Obsidian metadata cache into a list of edit records
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fetching — one edit → bytes + dims, over vault or network
// ---------------------------------------------------------------------------

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

// Fetch outcomes returned by {@link PicSource.resolve}. A caller inspects the
// tag and either handles the terminal state or reads the payload.
//   RESOLVE_OK        — success: `{tfile, resourcePath, bytes, dims}`.
//   RESOLVE_SKIP      — this image was considered but can't proceed
//                       (unresolved link, dims failed, download exhausted).
//                       Counted as `skipped` by the caller.
//   RESOLVE_IGNORE    — not an image / not a link we can act on. Not counted.
//   RESOLVE_CANCELLED — job was cancelled mid-fetch; caller must abort the batch.
const RESOLVE_OK = "ok";
const RESOLVE_SKIP = "skip";
const RESOLVE_IGNORE = "ignore";
const RESOLVE_CANCELLED = "cancelled";

/**
 * `PicSource` is the "how do I get an image's bytes + natural dimensions?"
 * side of the resize pipeline. It knows how to:
 *
 *   1. discover image references from `metadataCache` (local embeds +
 *      section-scanned externals);
 *   2. resolve a single reference to concrete bytes/dimensions, whether that
 *      means asking the vault for a resource path or downloading over the
 *      network with cancellable retries.
 *
 * It knows nothing about OCR or how the caller uses the result. Failure
 * modes are enumerated (RESOLVE_*) so the caller can decide accounting
 * (`considered` / `skipped`) without having to reason about which branch
 * failed.
 */
class PicSource {
    /**
     * @param {import("obsidian").App} app
     * @param {{ isCancelled: () => boolean, backoffMs?: number }} [options]
     */
    constructor(app, options) {
        this.app = app;
        this._isCancelled = (options && options.isCancelled) || (() => false);
        // Backoff between external-image retry attempts. Callers (tests) can
        // set this to 0 to keep retry tests instantaneous.
        this.externalFetchBackoffMs = options && options.backoffMs !== undefined
            ? options.backoffMs
            : EXTERNAL_FETCH_BACKOFF_MS;
    }

    /**
     * Discover every image reference in `content` that either lives in the
     * metadata cache (`embeds`) or sits in a scannable section (`sections`).
     * Returns edit records ordered so the caller can splice them from the
     * end without invalidating earlier offsets.
     */
    collectReferences(content, embeds, sections) {
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
     * Resolve a single edit record to `{tfile, resourcePath, bytes, dims}`.
     * `sourcePath` is the current note path, used by Obsidian's
     * `getFirstLinkpathDest` to disambiguate relative links.
     *
     * The outer resize loop calls this for every candidate edit and then
     * inspects `.kind`:
     *   - "ok"        → run OCR next.
     *   - "skip"      → increment `skipped`, continue.
     *   - "ignore"    → continue (didn't count as `considered`).
     *   - "cancelled" → propagate the cancelled result.
     *
     * @param {ReturnType<PicSource["collectReferences"]>[number]} edit
     * @param {string} sourcePath
     * @returns {Promise<{
     *   kind: "ok",
     *   external: boolean,
     *   tfile: import("obsidian").TFile | null,
     *   resourcePath: string | null,
     *   bytes: Uint8Array | null,
     *   dims: {naturalWidth: number, naturalHeight: number},
     *   linkForLog: string,
     * } | { kind: "skip" | "ignore" | "cancelled" }>}
     */
    async resolve(edit, sourcePath) {
        return edit.external
            ? this._resolveExternal(edit)
            : this._resolveLocal(edit, sourcePath);
    }

    async _resolveLocal(edit, sourcePath) {
        const rawLinkpath = urlToLinkpath(edit.link);
        // Unresolved link or other-scheme URI (file://, app://, data:, …) is
        // silently skipped, not counted.
        if (!rawLinkpath || EXTERNAL_URL_RE.test(rawLinkpath)) {
            return { kind: RESOLVE_IGNORE };
        }
        if (!IMAGE_EXT_RE.test(rawLinkpath)) return { kind: RESOLVE_IGNORE };
        // From here on, this image is definitely "considered".
        if (!OCR_SUPPORTED_EXT_RE.test(rawLinkpath)) return { kind: RESOLVE_SKIP };
        const tfile = this.app.metadataCache.getFirstLinkpathDest(rawLinkpath, sourcePath);
        if (!tfile) return { kind: RESOLVE_SKIP };
        const resourcePath = this.app.vault.getResourcePath(tfile);
        const dims = await loadImageDimensions(resourcePath);
        if (!dims || !dims.naturalWidth) return { kind: RESOLVE_SKIP };
        if (this._isCancelled()) return { kind: RESOLVE_CANCELLED };
        return {
            kind: RESOLVE_OK,
            external: false,
            tfile,
            resourcePath,
            bytes: null,
            dims,
            linkForLog: rawLinkpath,
        };
    }

    async _resolveExternal(edit) {
        // Preserve the URL verbatim so percent-encoded bytes reach the server
        // unchanged. Do NOT decodeURIComponent here.
        const fetchUrl = String(edit.link).trim();
        const pathForExt = urlPathnameFor(fetchUrl);
        if (!IMAGE_EXT_RE.test(pathForExt)) return { kind: RESOLVE_IGNORE };
        // From here on, this image is definitely "considered".
        if (!OCR_SUPPORTED_EXT_RE.test(pathForExt)) return { kind: RESOLVE_SKIP };

        let bytes;
        try {
            bytes = await fetchExternalImageBytes(
                fetchUrl,
                this._isCancelled,
                this.externalFetchBackoffMs,
            );
        } catch (err) {
            if (this._isCancelled()) return { kind: RESOLVE_CANCELLED };
            console.error(
                "resize-pics: failed to fetch external image", fetchUrl, err,
            );
            return { kind: RESOLVE_SKIP };
        }
        if (this._isCancelled()) return { kind: RESOLVE_CANCELLED };
        // fetchExternalImageBytes returns null only on cancel.
        if (bytes === null) return { kind: RESOLVE_CANCELLED };

        const dims = await loadImageDimensionsFromBytes(bytes);
        if (this._isCancelled()) return { kind: RESOLVE_CANCELLED };
        if (!dims || !dims.naturalWidth) return { kind: RESOLVE_SKIP };

        return {
            kind: RESOLVE_OK,
            external: true,
            tfile: null,
            resourcePath: null,
            bytes,
            dims,
            linkForLog: fetchUrl,
        };
    }
}

module.exports = {
    PicSource,
    RESOLVE_OK,
    RESOLVE_SKIP,
    RESOLVE_IGNORE,
    RESOLVE_CANCELLED,
};

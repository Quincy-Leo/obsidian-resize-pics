/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

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

// URI schemes we treat as external and never rewrite.
//   matches: "https://x.com/a.png", "http://…", "file://…"    mismatches: "foo.png", "sub/foo.png"
const EXTERNAL_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

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
        const {
            newContent,
            resized,
            skipped,
            considered,
            aborted: rewriteAborted,
            cancelled: rewriteCancelled,
        } = await this.rewriteContent(original, view.file.path, bodyFontPx, embeds, token);

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
     * Build source edits from parser-confirmed embed positions, resolving and
     * measuring each image through the vault before returning rewritten content
     * plus counters. Public so it can be unit-tested independently of a view.
     *
     * @param {string} content
     * @param {string} sourcePath
     * @param {number} bodyFontPx
     * @param {import("obsidian").EmbedCache[] | undefined} embeds
     */
    async rewriteContent(content, sourcePath, bodyFontPx, embeds, token) {
        const edits = collectImageReferences(content, embeds);
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
            const rawLinkpath = urlToLinkpath(edit.link);
            if (!rawLinkpath || EXTERNAL_URL_RE.test(rawLinkpath)) continue;
            if (!IMAGE_EXT_RE.test(rawLinkpath)) continue;

            considered += 1;

            // Formats outside tesseract.js's decoder set (gif/svg/avif/tiff)
            // count as considered-but-skipped rather than causing the batch
            // to blow up when the worker rejects the bytes.
            if (!OCR_SUPPORTED_EXT_RE.test(rawLinkpath)) { skipped += 1; continue; }

            const tfile = this.app.metadataCache.getFirstLinkpathDest(rawLinkpath, sourcePath);
            if (!tfile) { skipped += 1; continue; }

            const resourcePath = this.app.vault.getResourcePath(tfile);
            const dims = await loadImageDimensions(resourcePath);
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

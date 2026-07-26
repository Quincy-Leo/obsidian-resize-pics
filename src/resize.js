/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const { localizedError } = require("./settings");
const { ImageTextHeightDetector } = require("./ocr");
const {
    PicSource,
    RESOLVE_OK,
    RESOLVE_SKIP,
    RESOLVE_IGNORE,
    RESOLVE_CANCELLED,
} = require("./getPics");

const CONTENT_ROOT_SELECTORS = [".markdown-preview-view", ".cm-content"];

// Obsidian's size syntax: `WIDTH` or `WIDTHxHEIGHT` (integers).
//   matches: "386", "386x200", "  42  "     mismatches: "abc", "3.5", "386x", ""
const SIZE_SEGMENT_RE = /^\s*\d+(?:x\d+)?\s*$/;

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
        // Backoff between external-image retry attempts. Exposed so tests
        // can set it to 0 without hard-coding a fast path into PicSource.
        this._externalFetchBackoffMs = undefined;
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
     * image (through {@link PicSource}) before returning rewritten content
     * plus counters. Public so it can be unit-tested independently of a view.
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
        // Backward-compat: legacy 5-arg call sites (existing unit tests)
        // passed `token` in the `sections` position. Detect and shift.
        if (token === undefined && sections !== undefined
            && !Array.isArray(sections)
            && typeof sections === "object"
            && ("jobGeneration" in sections || "pluginGeneration" in sections)) {
            token = sections;
            sections = undefined;
        }

        const picSource = new PicSource(this.app, {
            isCancelled: () => this._isCancelled(token),
            backoffMs: this._externalFetchBackoffMs,
        });
        const edits = picSource.collectReferences(content, embeds, sections);

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

        const cancelledResult = () => ({
            newContent: result,
            resized,
            skipped,
            considered,
            aborted: true,
            cancelled: true,
        });

        for (const edit of edits) {
            if (this._isCancelled(token)) return cancelledResult();

            // Ask PicSource to turn this edit into concrete bytes/dims.
            // `resolved.kind` tells us how to account for it.
            const resolved = await picSource.resolve(edit, sourcePath);
            if (resolved.kind === RESOLVE_CANCELLED) return cancelledResult();
            if (resolved.kind === RESOLVE_IGNORE) continue;
            if (resolved.kind === RESOLVE_SKIP) {
                // A "skip" outcome only ever fires AFTER PicSource has
                // determined the image was in-scope, so it always counts
                // toward `considered`.
                considered += 1;
                skipped += 1;
                continue;
            }
            // RESOLVE_OK from here on.
            considered += 1;
            const { tfile, resourcePath, bytes, dims, linkForLog } = resolved;

            // Bring the OCR worker up on the first image that would
            // actually use it. Do NOT wrap in try/catch — see workerReady
            // declaration above for why global failures must propagate.
            if (!workerReady) {
                try {
                    await this.imageTextHeightDetector.ensureWorker();
                } catch (err) {
                    if (this._isCancelled(token)) return cancelledResult();
                    throw err;
                }
                workerReady = true;
            }

            if (this._isCancelled(token)) return cancelledResult();

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
                    bytes,
                    naturalWidth: dims.naturalWidth,
                    naturalHeight: dims.naturalHeight,
                });
            } catch (err) {
                if (this._isCancelled(token)) return cancelledResult();
                console.error("resize-pics: OCR failed for", linkForLog, err);
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

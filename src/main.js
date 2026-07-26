/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const { MarkdownView, Notice, Plugin, setTooltip } = require("obsidian");
const {
    LANGUAGE_OPTIONS,
    ResizePicsSettings,
    ResizePicsSettingTab,
} = require("./settings");
const { ResizeImagesJob } = require("./resize");

const PLUGIN_VERSION = "0.1.0";
const RESIZE_COMMAND_ID = "resize-pics-to-font-size";
const RIBBON_ICON_ID = "image-upscale";
const NOTICE_DURATION_MS = 4000;

class ResizePicsPlugin extends Plugin {
    constructor(...args) {
        super(...args);
        this.settings = null;
        this.settingsStore = null;
        this.resizeJob = null;
        this.resizeCommand = null;
        this.ribbonIconEl = null;
        this.resizing = false;
        this.__resizePicsUnloaded = false;
        this._lifecycleGeneration = 0;
        this._settingTabs = new Set();
        this.resizePics = () => {
            void this.resizePicsToFontSize();
        };
    }

    async onload() {
        this.__resizePicsUnloaded = false;
        this._lifecycleGeneration += 1;
        this.settingsStore = new ResizePicsSettings(this, () => {
            this.settings = this.settingsStore.value;
            this.refreshLocalizedEntryLabels();
        });
        await this.loadSettings();
        this.resizeJob = new ResizeImagesJob(this);

        this.resizeCommand = this.addCommand({
            id: RESIZE_COMMAND_ID,
            name: this.uiText.commandName,
            callback: this.resizePics,
        });

        this.ribbonIconEl = this.addRibbonIcon(
            RIBBON_ICON_ID,
            this.uiText.ribbonTitle,
            this.resizePics,
        );
        if (this.ribbonIconEl && typeof setTooltip === "function") {
            setTooltip(this.ribbonIconEl, this.uiText.ribbonTitle);
        }

        const settingTab = new ResizePicsSettingTab(this.app, this.settingsStore);
        this._settingTabs.add(settingTab);
        this.addSettingTab(settingTab);

        console.log(`resize-pics ${PLUGIN_VERSION} loaded`);
    }

    onunload() {
        if (this.__resizePicsUnloaded) return;
        // Mark the lifecycle inactive before touching async resources. Pending
        // jobs use this flag and the generation to suppress later side effects.
        this.__resizePicsUnloaded = true;
        this._lifecycleGeneration += 1;
        this.resizing = false;

        for (const tab of this._settingTabs) {
            if (tab && typeof tab.dispose === "function") tab.dispose();
        }
        if (this.__resizePicsSettingTabs instanceof Set) {
            for (const tab of this.__resizePicsSettingTabs) {
                if (tab && typeof tab.dispose === "function") tab.dispose();
            }
        }
        if (this.__resizePicsDependencyManagers instanceof Set) {
            for (const manager of this.__resizePicsDependencyManagers) {
                if (manager && typeof manager.cancel === "function") manager.cancel();
            }
        }

        // Fire-and-forget: onunload cannot await cleanup. Synchronous cancellation
        // marks pending work first, so guarded continuations skip their remaining
        // persistent and user-visible effects while resources finish unwinding.
        const job = this.resizeJob;
        if (job) {
            if (typeof job.cancel === "function") job.cancel();
            if (typeof job.dispose === "function") {
                try {
                    Promise.resolve(job.dispose()).catch((error) => {
                        console.error("resize-pics: failed to dispose resize job", error);
                    });
                } catch (error) {
                    console.error("resize-pics: failed to dispose resize job", error);
                }
            }
        }
        this.resizeJob = null;
        this.ribbonIconEl = null;
    }

    get uiText() {
        return this.settingsStore
            ? this.settingsStore.uiText
            : LANGUAGE_OPTIONS[0];
    }

    async loadSettings() {
        this.settings = await this.settingsStore.load();
        return this.settings;
    }

    refreshLocalizedEntryLabels() {
        if (this.resizeCommand) {
            if (typeof this.removeCommand === "function") {
                this.removeCommand(RESIZE_COMMAND_ID);
                this.resizeCommand = this.addCommand({
                    id: RESIZE_COMMAND_ID,
                    name: this.uiText.commandName,
                    callback: this.resizePics,
                });
            } else {
                this.resizeCommand.name = this.uiText.commandName;
            }
        }
        if (this.ribbonIconEl) {
            if (typeof setTooltip === "function") {
                setTooltip(this.ribbonIconEl, this.uiText.ribbonTitle);
            }
            this.ribbonIconEl.setAttribute("aria-label", this.uiText.ribbonTitle);
        }
    }

    async resizePicsToFontSize() {
        if (this.__resizePicsUnloaded || this.resizing) return;

        const managers = this.__resizePicsDependencyManagers instanceof Set
            ? [...this.__resizePicsDependencyManagers]
            : [];
        if (this.dependencyManager) managers.push(this.dependencyManager);
        if (this.resizeJob
            && this.resizeJob.imageTextHeightDetector
            && this.resizeJob.imageTextHeightDetector.deps) {
            managers.push(this.resizeJob.imageTextHeightDetector.deps);
        }
        const dependencyOperation = this.__resizePicsDependencyOperation;
        const downloading = managers.some((manager) => manager
            && (manager.downloading
                || (manager._operation && manager._operation.kind === "download")));
        const clearing = managers.some((manager) => manager
            && (manager.clearing
                || (manager._operation && manager._operation.kind === "clear")));
        const sharedBusy = dependencyOperation && dependencyOperation.operation;
        if (downloading || clearing || sharedBusy) {
            const settingsText = this.uiText.settingsText || {};
            const message = downloading || (sharedBusy && sharedBusy.kind === "download")
                ? (settingsText.downloadInProgress || "resize-pics: download in progress.")
                : (settingsText.clearInProgress || "resize-pics: clear operation in progress.");
            new Notice(message, NOTICE_DURATION_MS);
            return;
        }

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) {
            new Notice(this.uiText.notice.noView, NOTICE_DURATION_MS);
            return;
        }

        this.resizing = true;
        new Notice(this.uiText.notice.start, NOTICE_DURATION_MS);

        const lifecycleGeneration = this._lifecycleGeneration;
        const job = this.resizeJob;
        try {
            const result = await job.run(view);
            if (this.__resizePicsUnloaded
                || lifecycleGeneration !== this._lifecycleGeneration
                || result.cancelled) return;
            if (result.aborted) {
                new Notice(this.uiText.notice.aborted, NOTICE_DURATION_MS);
                return;
            }
            if (result.considered === 0) {
                new Notice(this.uiText.notice.noImages, NOTICE_DURATION_MS);
                return;
            }
            const message = this.uiText.notice.resized
                .replace("{count}", String(result.resized))
                .replace("{skipped}", String(result.skipped));
            new Notice(message, NOTICE_DURATION_MS);
        } catch (error) {
            if (this.__resizePicsUnloaded || lifecycleGeneration !== this._lifecycleGeneration) return;
            console.error("resize-pics: rewrite failed", error);
            // Localised error messages already include a `resize-pics:` /
            // `resize-pics：` prefix (see localizedError in settings.js);
            // don't re-prefix or the Notice reads "resize-pics: resize-pics: …".
            // Fall back to a manual prefix only when the error isn't one of
            // ours (e.g. a stray runtime exception with no locale context).
            const raw = error instanceof Error ? error.message : String(error);
            const message = /^resize-pics[:：]/.test(raw) ? raw : `resize-pics: ${raw}`;
            new Notice(message, NOTICE_DURATION_MS);
        } finally {
            this.resizing = false;
        }
    }
}

// Default export loaded by the Obsidian plugin runtime.
module.exports = ResizePicsPlugin;

// Named export used by the Node unit tests.
module.exports.ResizePicsPlugin = ResizePicsPlugin;

/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const { Notice, PluginSettingTab, Setting } = require("obsidian");
const { TesseractDependencyManager } = require("./tesseractDeps");

const NOTICE_DURATION_MS = 4000;

const LANGUAGE_OPTIONS = [
    {
        value: "zh-CN",
        label: "中文",
        commandName: "将图片缩放到与正文字号一致",
        ribbonTitle: "将图片缩放到与正文字号一致",
        notice: {
            noView: "resize-pics：请先打开一个 Markdown 视图。",
            noImages: "resize-pics：当前视图中没有找到可缩放的图片。",
            resized: "resize-pics：已缩放 {count} 张图片（跳过 {skipped} 张）。",
            aborted: "resize-pics：检测期间不要编辑文件，请重试。",
        },
        error: {
            settingsMissingVersion:
                "resize-pics：配置文件缺少 “version” 字段；期望值为 {expected}。",
            settingsBadVersion:
                "resize-pics：不支持的配置文件版本 {actual}；期望值为 {expected}。",
            noActiveFile: "resize-pics：获取当前文档失败。",
            noContentRoot: "resize-pics：获取正文字号失败。",
            invalidFontSize: "resize-pics：获取正文字号非法。",
            atomicProcessUnavailable:
                "resize-pics：当前 Obsidian 不支持原子文件更新 API（Vault.process）；请升级 Obsidian。",
            ocrDepsMissing:
                "resize-pics：OCR 依赖项未就绪（缺少 {missing}/{total}：{names}）；请在设置中下载。",
            ocrAdapterMissing:
                "resize-pics：Obsidian不支持读取插件目录中的依赖文件。",
            ocrDetectBeforeEnsure:
                "resize-pics：内部错误：在 ensureWorker() 之前调用了 detect()。",
        },
        settingsText: {
            languageName: "Language / 语言",
            languageDesc: "插件显示的界面语言",
            ocrHeading: "OCR 依赖项",
            ocrDesc:
                "识别图片中文本高度需要 Tesseract.js 相关资源。请预先下载到插件目录。",
            statusChecking: "正在检查依赖项……",
            statusMissing: "缺少 {missing}/{total} 项：{names}。",
            statusReady: "全部 {total} 项依赖已就绪。",
            statusError: "检查依赖项失败：{message}",
            downloadButton: "下载依赖项",
            downloadingButton: "正在下载……",
            clearButton: "清空缓存",
            clearingButton: "正在清空……",
            downloadStart: "resize-pics：开始下载 Tesseract 依赖项……",
            downloadProgress: "resize-pics：正在下载 {name}（{current}/{total}）",
            downloadDone: "resize-pics：依赖下载完成（新增 {downloaded}，已存在 {skipped}）。",
            downloadPartial:
                "resize-pics：依赖下载部分失败：{failedCount}/{total}（{failedNames}）。",
            downloadInProgress: "resize-pics：已有下载任务在进行中。",
            clearDone: "resize-pics：已清空 {count} 个依赖文件。",
            clearInProgress: "resize-pics：已有清空任务在进行中。",
        },
    },
    {
        value: "en",
        label: "English",
        commandName: "Resize pics to font size",
        ribbonTitle: "Resize pics to font size",
        notice: {
            noView: "resize-pics: open a Markdown view first.",
            noImages: "resize-pics: no resizable images found in the current view.",
            resized: "resize-pics: resized {count} image(s) (skipped {skipped}).",
            aborted: "resize-pics: Do not edit file during detection. Please try again.",
        },
        error: {
            settingsMissingVersion:
                "resize-pics: settings file is missing \"version\"; expected {expected}.",
            settingsBadVersion:
                "resize-pics: unsupported settings version {actual}; expected {expected}.",
            noActiveFile: "resize-pics: failed to get the active note.",
            noContentRoot: "resize-pics: failed to read body font size.",
            invalidFontSize: "resize-pics: body font size is invalid.",
            atomicProcessUnavailable:
                "resize-pics: this Obsidian version does not support atomic file updates (Vault.process); please upgrade Obsidian.",
            ocrDepsMissing:
                "resize-pics: OCR dependencies not ready ({missing}/{total} missing: {names}); please download them in Settings.",
            ocrAdapterMissing:
                "resize-pics: this Obsidian cannot read plugin-folder assets.",
            ocrDetectBeforeEnsure:
                "resize-pics: internal error: detect() called before ensureWorker().",
        },
        settingsText: {
            languageName: "Language",
            languageDesc: "Interface language for plugin.",
            ocrHeading: "OCR dependencies",
            ocrDesc:
                "Detecting text height in images needs Tesseract.js runtime files. Please download them into the plugin folder.",
            statusChecking: "Checking dependencies…",
            statusMissing: "Missing {missing}/{total}: {names}.",
            statusReady: "All {total} dependencies are ready.",
            statusError: "Failed to check dependencies: {message}",
            downloadButton: "Download dependencies",
            downloadingButton: "Downloading…",
            clearButton: "Clear cache",
            clearingButton: "Clearing…",
            downloadStart: "resize-pics: downloading Tesseract dependencies…",
            downloadProgress: "resize-pics: downloading {name} ({current}/{total})",
            downloadDone: "resize-pics: dependencies downloaded ({downloaded} new, {skipped} already present).",
            downloadPartial:
                "resize-pics: dependency download partially failed: {failedCount}/{total} ({failedNames}).",
            downloadInProgress: "resize-pics: a download is already in progress.",
            clearDone: "resize-pics: removed {count} cached file(s).",
            clearInProgress: "resize-pics: a clear operation is already in progress.",
        },
    },
];

const DEFAULT_LANGUAGE = LANGUAGE_OPTIONS[0].value;

// Bump this when the on-disk schema changes in a way old code can't read.
// Unknown or missing versions are refused rather than silently migrated —
// migrations, when needed, will be added here explicitly.
const SETTINGS_SCHEMA_VERSION = 1;

/**
 * Render an error message in every supported language, joined on newlines.
 * Used ONLY for errors that can fire before we know which language the
 * user picked — chiefly settings-load failures (`settingsMissingVersion`,
 * `settingsBadVersion`), which happen before `settings.value` exists.
 * Once settings are loaded, prefer {@link localizedError} so users don't
 * see two languages stacked together in one Notice.
 *
 * @param {string} key Key inside each LANGUAGE_OPTIONS entry's `error` object.
 * @param {Record<string, string | number>} [params] Placeholder values.
 */
function bilingualError(key, params = {}) {
    return LANGUAGE_OPTIONS
        .map((option) => formatTemplate(option.error[key] || "", params))
        .filter(Boolean)
        .join("\n");
}

/**
 * Render an error message in the currently-selected language. Use this
 * for runtime errors — anything that can only fire after
 * {@link ResizePicsSettings.load} has resolved. The returned string
 * already begins with `resize-pics:` / `resize-pics：`, so callers that
 * feed it into a Notice should NOT prefix it again.
 *
 * @param {{ error: Record<string, string> }} uiText Typically `plugin.uiText`.
 * @param {string} key Key inside `uiText.error`.
 * @param {Record<string, string | number>} [params] Placeholder values.
 */
function localizedError(uiText, key, params = {}) {
    const template = (uiText && uiText.error && uiText.error[key]) || "";
    return formatTemplate(template, params);
}

function formatTemplate(template, params) {
    let out = template;
    for (const [name, value] of Object.entries(params)) {
        out = out.split(`{${name}}`).join(String(value));
    }
    return out;
}

class ResizePicsSettings {
    constructor(plugin, onLanguageChanged) {
        this.plugin = plugin;
        this.onLanguageChanged = onLanguageChanged || (() => {});
        this.value = null;
        this._saveGeneration = 0;
    }

    get uiText() {
        const language = this.value && this.value.language;
        return LANGUAGE_OPTIONS.find((option) => option.value === language)
            || LANGUAGE_OPTIONS[0];
    }

    async load() {
        const savedData = await this.plugin.loadData();
        const isFreshInstall = savedData === null || savedData === undefined;
        const saved = savedData && typeof savedData === "object" ? savedData : {};

        if (!isFreshInstall) {
            if (!Object.prototype.hasOwnProperty.call(saved, "version")) {
                throw new Error(bilingualError("settingsMissingVersion", {
                    expected: SETTINGS_SCHEMA_VERSION,
                }));
            }
            if (saved.version !== SETTINGS_SCHEMA_VERSION) {
                throw new Error(bilingualError("settingsBadVersion", {
                    actual: JSON.stringify(saved.version),
                    expected: SETTINGS_SCHEMA_VERSION,
                }));
            }
        }

        const language = LANGUAGE_OPTIONS.some((option) => option.value === saved.language)
            ? saved.language
            : DEFAULT_LANGUAGE;
        this.value = { version: SETTINGS_SCHEMA_VERSION, language };
        return this.value;
    }

    async setLanguage(language) {
        if (!LANGUAGE_OPTIONS.some((option) => option.value === language)) return;
        // Replace the object instead of mutating the one that may already have
        // been handed to saveData(). Each save therefore owns an immutable
        // snapshot even when the user changes the dropdown again immediately.
        this.value = { ...this.value, language };
        const generation = ++this._saveGeneration;
        await this.save(generation);
        if (generation === this._saveGeneration) this.onLanguageChanged();
    }

    async save(requestGeneration = this._saveGeneration) {
        let persistedGeneration = requestGeneration;
        try {
            // Saves may finish out of order. A stale save repairs its own late
            // write with the newest snapshot before resolving, which keeps the
            // final persisted value equal to the user's last selection without
            // blocking a newer selection behind an older slow write.
            while (true) {
                const snapshot = { ...this.value };
                await this.plugin.saveData(snapshot);
                if (persistedGeneration === this._saveGeneration) return;
                persistedGeneration = this._saveGeneration;
            }
        } catch (saveError) {
            // A stale failed save must not roll back a newer in-memory choice.
            if (requestGeneration === this._saveGeneration) {
                try {
                    await this.load();
                    this.onLanguageChanged();
                } catch (loadError) {
                    console.error(
                        "resize-pics: failed to reload settings after save failure",
                        loadError,
                    );
                }
            }
            throw saveError;
        }
    }
}

class ResizePicsSettingTab extends PluginSettingTab {
    constructor(app, settings) {
        super(app, settings.plugin);
        this.settings = settings;
        const plugin = settings.plugin;
        // Share the OCR manager when the plugin already created one. A
        // standalone tab (as in settings-only tests) creates and registers its
        // own manager, which is then also visible to plugin lifecycle checks.
        this.deps = (plugin && plugin.dependencyManager)
            || new TesseractDependencyManager(plugin);
        if (plugin && !plugin.dependencyManager) {
            try { plugin.dependencyManager = this.deps; } catch (_) { /* optional */ }
        }

        // Track asynchronous status probes so stale completions cannot write.
        // The render generation invalidates orphan DOM nodes, while a separate
        // request id makes the latest refresh win within one render.
        this._displayGeneration = 0;
        this._statusRequestId = 0;
        this._latestStatusRequest = 0;
        this._activeStatusEl = null;
        this._disposed = false;

        try {
            if (!(plugin.__resizePicsSettingTabs instanceof Set)) {
                plugin.__resizePicsSettingTabs = new Set();
            }
            plugin.__resizePicsSettingTabs.add(this);
        } catch (_) {
            // Optional lifecycle registration; a frozen host object should not
            // make the settings page unusable.
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._displayGeneration += 1;
        this._latestStatusRequest = ++this._statusRequestId;
        if (this.deps && typeof this.deps.cancel === "function") this.deps.cancel();
    }

    _isDisposed() {
        return this._disposed
            || Boolean(this.settings.plugin && this.settings.plugin.__resizePicsUnloaded);
    }

    _managerIsBusy(kind) {
        const plugin = this.settings.plugin;
        const managers = plugin && plugin.__resizePicsDependencyManagers instanceof Set
            ? [...plugin.__resizePicsDependencyManagers]
            : [this.deps];
        const localBusy = managers.some((manager) => {
            if (kind === "download") {
                return manager.downloading
                    || (manager._operation && manager._operation.kind === "download");
            }
            return manager.clearing
                || (manager._operation && manager._operation.kind === "clear");
        });
        const shared = plugin && plugin.__resizePicsDependencyOperation;
        return localBusy || Boolean(shared && shared.operation && shared.operation.kind === kind);
    }

    _isCurrentStatus(statusEl, generation) {
        return !this._isDisposed()
            && generation === this._displayGeneration
            && statusEl === this._activeStatusEl;
    }

    _refreshVisibleStatus() {
        if (this._isDisposed() || !this._activeStatusEl) return Promise.resolve();
        return this.refreshStatus(this._activeStatusEl, this._displayGeneration);
    }

    display() {
        if (this._isDisposed()) return;
        const generation = ++this._displayGeneration;
        this.containerEl.empty();
        const text = this.settings.uiText.settingsText;
        const value = this.settings.value;

        new Setting(this.containerEl)
            .setName(text.languageName)
            .setDesc(text.languageDesc)
            .addDropdown((dropdown) => {
                for (const option of LANGUAGE_OPTIONS) {
                    dropdown.addOption(option.value, option.label);
                }
                dropdown.setValue(value.language).onChange(async (language) => {
                    if (this._isDisposed()) return;
                    try {
                        await this.settings.setLanguage(language);
                    } finally {
                        if (!this._isDisposed()) this.display();
                    }
                });
            });

        this.renderDependencySection(generation);
    }

    /**
     * Draws the OCR dependency block: heading, live status line, and the two
     * action buttons. Called from {@link display}; completed actions refresh
     * the active status line without rebuilding the section.
     */
    renderDependencySection(generation = this._displayGeneration) {
        const text = this.settings.uiText.settingsText;

        // Use Setting.setHeading() so the section title inherits the same left
        // gutter and typography as Obsidian's built-in section headers.
        new Setting(this.containerEl).setName(text.ocrHeading).setHeading();

        // A single Setting owns the description + status line + both buttons.
        // Putting the status inside descEl keeps it left-aligned with the
        // surrounding description text and the buttons on its right.
        const setting = new Setting(this.containerEl).setDesc(text.ocrDesc);
        const statusEl = setting.descEl.createDiv({
            text: text.statusChecking,
            cls: "resize-pics-ocr-status",
        });
        // Separate the live status line from the static description above with
        // both extra breathing room and a subtle divider that follows the
        // Obsidian theme (light/dark) via CSS variables.
        statusEl.style.marginTop = "0.75em";
        statusEl.style.paddingTop = "0.6em";
        statusEl.style.borderTop = "1px solid var(--background-modifier-border)";

        let downloadButtonRef = null;
        let clearButtonRef = null;

        setting.addButton((button) => {
            downloadButtonRef = button;
            button.setButtonText(text.downloadButton).onClick(async () => {
                await this.handleDownload(button, clearButtonRef, statusEl, generation);
            });
        });
        setting.addButton((button) => {
            clearButtonRef = button;
            button.setButtonText(text.clearButton).onClick(async () => {
                await this.handleClear(button, downloadButtonRef, statusEl, generation);
            });
        });

        this._activeStatusEl = statusEl;
        this._syncOperationButtons(downloadButtonRef, clearButtonRef, text);

        // Kick off the probe. It's async so the initial "checking…" text is
        // visible until the disk read returns.
        void this.refreshStatus(statusEl, generation);
    }

    _syncOperationButtons(downloadButton, clearButton, text) {
        const downloading = this._managerIsBusy("download");
        const clearing = this._managerIsBusy("clear");
        if (downloadButton) {
            downloadButton
                .setDisabled(downloading || clearing)
                .setButtonText(downloading ? text.downloadingButton : text.downloadButton);
        }
        if (clearButton) {
            clearButton
                .setDisabled(downloading || clearing)
                .setButtonText(clearing ? text.clearingButton : text.clearButton);
        }
    }

    /**
     * Populate the status line from a fresh disk scan. Render generations drop
     * results for discarded DOM, and request ids make the latest probe win
     * within the active render.
     */
    async refreshStatus(statusEl, renderGeneration) {
        // Direct callers without a render token start an independent probe and
        // invalidate the previous render. Display-owned refreshes reuse their
        // generation so an orphan handler cannot invalidate the visible page.
        const generation = renderGeneration === undefined
            ? ++this._displayGeneration
            : renderGeneration;
        const requestId = ++this._statusRequestId;
        this._latestStatusRequest = requestId;
        const text = this.settings.uiText.settingsText;
        try {
            const status = await this.deps.checkStatus();
            if (!this._isCurrentStatus(statusEl, generation)
                || requestId !== this._latestStatusRequest) return;
            if (status.missing.length === 0) {
                statusEl.setText(formatTemplate(text.statusReady, {
                    total: status.total,
                }));
                statusEl.removeClass("resize-pics-status-missing");
                statusEl.addClass("resize-pics-status-ready");
            } else {
                statusEl.setText(formatTemplate(text.statusMissing, {
                    missing: status.missing.length,
                    total: status.total,
                    names: status.missing.join(", "),
                }));
                statusEl.removeClass("resize-pics-status-ready");
                statusEl.addClass("resize-pics-status-missing");
            }
        } catch (err) {
            if (!this._isCurrentStatus(statusEl, generation)
                || requestId !== this._latestStatusRequest) return;
            const message = err instanceof Error ? err.message : String(err);
            statusEl.setText(formatTemplate(text.statusError, { message }));
        }
    }

    async handleDownload(downloadButton, clearButton, statusEl, renderGeneration = this._displayGeneration) {
        if (this._isDisposed()) return;
        const text = this.settings.uiText.settingsText;
        if (this._managerIsBusy("download")) {
            new Notice(text.downloadInProgress, NOTICE_DURATION_MS);
            return;
        }
        downloadButton.setDisabled(true).setButtonText(text.downloadingButton);
        if (clearButton) clearButton.setDisabled(true);
            new Notice(text.downloadStart, NOTICE_DURATION_MS);
        try {
            const result = await this.deps.downloadAll((progress) => {
                if (this._isDisposed() || !this._isCurrentStatus(statusEl, renderGeneration)) return;
                if (progress.phase === "start") {
                    statusEl.setText(formatTemplate(text.downloadProgress, {
                        name: progress.name,
                        current: progress.current,
                        total: progress.total,
                    }));
                }
            });
            if (this._isDisposed()) return;
            if (result === null) {
                new Notice(text.downloadInProgress, NOTICE_DURATION_MS);
                return;
            }
            if (result.cancelled) return;
            if (result.failed.length > 0) {
                new Notice(
                    formatTemplate(text.downloadPartial, {
                        failedCount: result.failed.length,
                        total: result.failed.length + result.downloaded + result.skipped,
                        failedNames: result.failed.map((f) => f.name).join(", "),
                    }),
                    NOTICE_DURATION_MS,
                );
                console.error("resize-pics: dependency download failures", result.failed);
            } else {
                new Notice(
                    formatTemplate(text.downloadDone, {
                        downloaded: result.downloaded,
                        skipped: result.skipped,
                    }),
                    NOTICE_DURATION_MS,
                );
            }
        } catch (err) {
            if (this._isDisposed()) return;
            console.error("resize-pics: dependency download failed", err);
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`resize-pics: ${message}`, NOTICE_DURATION_MS);
        } finally {
            // An orphan handler must not mutate a newly-rendered button. Its
            // completion still refreshes the currently visible status line so
            // a page that was redrawn during the operation does not stay at
            // "checking" forever.
            if (!this._isDisposed() && renderGeneration === this._displayGeneration) {
                downloadButton.setDisabled(false).setButtonText(text.downloadButton);
                if (clearButton) clearButton.setDisabled(false);
            }
            if (!this._isDisposed()) await this._refreshVisibleStatus();
        }
    }

    async handleClear(clearButton, downloadButton, statusEl, renderGeneration = this._displayGeneration) {
        if (this._isDisposed()) return;
        const text = this.settings.uiText.settingsText;
        if (this._managerIsBusy("clear")) {
            new Notice(text.clearInProgress, NOTICE_DURATION_MS);
            return;
        }
        clearButton.setDisabled(true).setButtonText(text.clearingButton);
        if (downloadButton) downloadButton.setDisabled(true);
        try {
            // Invalidate and stop an in-flight resize before removing the OCR
            // assets. This makes the note update all-or-nothing when clear and
            // OCR are interleaved.
            const resizeJob = this.settings.plugin && this.settings.plugin.resizeJob;
            if (resizeJob && typeof resizeJob.cancel === "function") resizeJob.cancel();
            if (resizeJob && typeof resizeJob.dispose === "function") {
                try {
                    await resizeJob.dispose();
                } catch (e) {
                    console.error("resize-pics: failed to terminate OCR worker before clear", e);
                }
            }
            if (this._isDisposed()) return;
            const result = await this.deps.clearCache();
            if (this._isDisposed()) return;
            if (result === null) {
                new Notice(text.clearInProgress, NOTICE_DURATION_MS);
                return;
            }
            if (result.cancelled) return;
            // Dispose again in case a worker was recreated while the initial
            // termination or disk clear was awaiting. A surviving Tesseract
            // worker could keep recognizing from its loaded WASM FS after the
            // on-disk and IDB copies are gone. dispose() clears the cached worker
            // promise and Blob URLs, so the next resize re-enters spawnWorker
            // and reports the missing assets through its dependency check.
            if (resizeJob) {
                try {
                    await resizeJob.dispose();
                } catch (e) {
                    // Best-effort — a stuck terminate shouldn't hide the
                    // successful disk+IDB clear from the user.
                    console.error("resize-pics: failed to terminate OCR worker after clear", e);
                }
            }
            new Notice(
                formatTemplate(text.clearDone, { count: result.removed.length }),
                NOTICE_DURATION_MS,
            );
        } catch (err) {
            if (this._isDisposed()) return;
            console.error("resize-pics: clear cache failed", err);
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`resize-pics: ${message}`, NOTICE_DURATION_MS);
        } finally {
            if (!this._isDisposed() && renderGeneration === this._displayGeneration) {
                clearButton.setDisabled(false).setButtonText(text.clearButton);
                if (downloadButton) downloadButton.setDisabled(false);
            }
            if (!this._isDisposed()) await this._refreshVisibleStatus();
        }
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
//
// 其他模块会调用的接口：
//   - LANGUAGE_OPTIONS     语言配置表（main.js 兜底取 [0] 作为默认 uiText）
//   - ResizePicsSettings   持久化设置（main.js 在 onload 中构造并 load()）
//   - ResizePicsSettingTab 设置页 UI（main.js 传给 addSettingTab）
//   - bilingualError       未确定语言前的错误文案（load 失败时使用）
//   - localizedError       已确定语言后的错误文案（运行时错误使用）
//
// 用户操作触发的接口（导出以便单元测试直接构造相应类后调用）：
//   - ResizePicsSettings.prototype.setLanguage(language)
//       由设置页语言下拉框 onChange 触发。
//   - ResizePicsSettingTab.prototype.display()
//       由 Obsidian 打开本插件设置页时触发（Obsidian 直接调用）。
//   - ResizePicsSettingTab.prototype.handleDownload(downloadButton, clearButton, statusEl, renderGeneration)
//       由设置页 “下载依赖项 / Download dependencies” 按钮 onClick 触发。
//   - ResizePicsSettingTab.prototype.handleClear(clearButton, downloadButton, statusEl, renderGeneration)
//       由设置页 “清空缓存 / Clear cache” 按钮 onClick 触发。
module.exports = {
    LANGUAGE_OPTIONS,
    ResizePicsSettings,
    ResizePicsSettingTab,
    bilingualError,
    localizedError,
};

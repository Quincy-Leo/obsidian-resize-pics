/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const boot = require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ImageTextHeightDetector } = require("../src/ocr");
const { ResizeImagesJob } = require("../src/resize");
const {
    ResizePicsSettings,
    ResizePicsSettingTab,
} = require("../src/settings");
const ResizePicsPlugin = require("../src/main");
const { makeFakePlugin, sha256Hex } = require("./helpers/fakePlugin");
const { loadWithAssets } = require("./helpers/loadTesseractDeps");

// ============================================================================
// 复合操作 / 交错时序下的状态安全测试
// ============================================================================
//
// 原则：尽量从真实用户入口启动操作，再只在不可控的外部边界（网络、OCR
// worker、用户编辑发生的时刻）放 deferred gate。测试允许安全实现选择“拒绝”
// 或“串行化”，但不允许两个破坏性操作真正重叠，也不允许静默部分写回。

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((r, j) => { resolve = r; reject = j; });
    return { promise, resolve, reject };
}

/** 让 promise/事件循环前进若干轮，不依赖真实时间。 */
function drainTasks(turns = 6) {
    let pending = Promise.resolve();
    for (let i = 0; i < turns; i++) {
        pending = pending.then(() => new Promise(setImmediate));
    }
    return pending;
}

async function waitFor(predicate, message, turns = 100) {
    for (let i = 0; i < turns; i++) {
        if (predicate()) return;
        await new Promise(setImmediate);
    }
    assert.ok(predicate(), message);
}

async function makePluginWithSettings() {
    const plugin = makeFakePlugin();
    plugin.manifest.dir = ".obsidian/plugins/resize-pics";
    const settings = new ResizePicsSettings(plugin);
    await settings.load();
    plugin.settingsStore = settings;
    plugin.settings = settings.value;
    Object.defineProperty(plugin, "uiText", {
        get() { return settings.uiText; },
        configurable: true,
    });
    return { plugin, settings };
}

/** 走完整个 onload，返回真实 plugin 实例和它注册的 SettingTab。 */
async function bootFullPlugin() {
    const fake = makeFakePlugin();
    fake.manifest.dir = ".obsidian/plugins/resize-pics";
    const plugin = new ResizePicsPlugin(fake.app, fake.manifest);
    plugin.loadData = fake.loadData.bind(fake);
    plugin.saveData = fake.saveData.bind(fake);
    let capturedTab = null;
    plugin.addSettingTab = (tab) => { capturedTab = tab; };
    plugin.__setActiveView = (view) => {
        plugin.app.workspace.getActiveViewOfType = () => view;
    };
    await plugin.onload();
    return { plugin, tab: capturedTab, fake };
}

function makeView(file) {
    return {
        file,
        containerEl: { querySelector: () => ({}) },
    };
}

function successfulOcrResult() {
    return {
        data: {
            lines: [
                { bbox: { x0: 0, y0: 0, x1: 100, y1: 16 }, confidence: 90 },
                { bbox: { x0: 0, y0: 20, x1: 100, y1: 36 }, confidence: 90 },
            ],
        },
    };
}

const BYTES_OK = Uint8Array.from(Buffer.from("hello resize-pics"));
const SHA_OK = sha256Hex(BYTES_OK);

function toAB(bytes) {
    const result = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(result).set(bytes);
    return result;
}

function makeAssets() {
    return [
        { name: "a.bin", url: "https://example.test/a.bin", sha256: SHA_OK },
        { name: "b.bin", url: "https://example.test/b.bin", sha256: SHA_OK },
    ];
}

function beginButtonSpy() {
    const buttons = [];
    const original = boot.obsidian.Setting.prototype.addButton;
    boot.obsidian.Setting.prototype.addButton = function (callback) {
        return original.call(this, (button) => {
            buttons.push(button);
            callback(button);
        });
    };
    return {
        buttons,
        stop() { boot.obsidian.Setting.prototype.addButton = original; },
    };
}

/** 调用真实 display()，同时取回这次 render 创建的两个按钮和状态节点。 */
function renderTab(tab) {
    const spy = beginButtonSpy();
    try {
        tab.display();
    } finally {
        spy.stop();
    }
    assert.equal(spy.buttons.length, 2, "依赖区应渲染下载、清空两个按钮");
    const settings = tab.containerEl.children;
    const dependencySetting = settings[settings.length - 1];
    const statusEl = dependencySetting.descEl.children[0];
    assert.ok(statusEl, "依赖区应渲染状态节点");
    return {
        downloadButton: spy.buttons[0],
        clearButton: spy.buttons[1],
        statusEl,
    };
}

// ---------------------------------------------------------------------------
// Resize 命令、文件提交与 OCR 生命周期
// ---------------------------------------------------------------------------

test("[01] 快速连续触发两次 resize：真实命令入口只能启动一个 job", async () => {
    const { plugin } = await bootFullPlugin();
    const runGate = deferred();
    const runEntered = deferred();
    let runCalls = 0;
    plugin.resizeJob = {
        async run() {
            runCalls += 1;
            runEntered.resolve();
            await runGate.promise;
            return { considered: 1, resized: 1, skipped: 0, aborted: false };
        },
        async dispose() {},
    };
    plugin.__setActiveView(makeView({ path: "note.md", __contents: "![[a.png]]" }));
    boot.resetNotices();

    let firstRun;
    try {
        firstRun = plugin.resizePicsToFontSize();
        await runEntered.promise;
        await plugin.resizePicsToFontSize();
    } finally {
        runGate.resolve();
        if (firstRun) await firstRun;
    }

    assert.equal(runCalls, 1, "第二次触发应被 resizing 锁合并");
    assert.equal(plugin.resizing, false, "首个任务结束后必须释放 resizing 锁");
    assert.equal(boot.noticeLog.length, 1, "只应汇报一次 resize 结果");
});

test("[02] OCR 期间用户编辑文件：提交前复查应 abort，且保留用户内容", async () => {
    const { plugin } = await makePluginWithSettings();
    const file = { path: "note.md", __contents: "before ![[a.png]]" };
    const userEdit = "USER EDIT\nbefore ![[a.png]]";
    const detectGate = deferred();
    const detectEntered = deferred();
    const job = new ResizeImagesJob(plugin);
    job.imageTextHeightDetector = {
        async ensureWorker() {},
        async detect() {
            detectEntered.resolve();
            await detectGate.promise;
            return 16;
        },
        async terminate() {},
    };
    boot.setComputedFontSize("16px");
    boot.setImageLoader(() => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));

    let runPromise;
    let result;
    try {
        runPromise = job.run(makeView(file));
        await detectEntered.promise;
        file.__contents = userEdit;
        detectGate.resolve();
        result = await runPromise;
    } finally {
        detectGate.resolve();
        if (runPromise) await Promise.allSettled([runPromise]);
    }

    assert.equal(result.aborted, true);
    assert.equal(file.__contents, userEdit, "OCR 期间产生的用户编辑不能被覆盖");
});

test("[03] 初次 read 后、原子 process 提交前用户编辑：仍不能发生丢失更新", async () => {
    const { plugin } = await makePluginWithSettings();
    const original = "before ![[a.png]]";
    const userEdit = "USER EDIT after validation\n" + original;
    const file = { path: "note.md", __contents: original };
    const job = new ResizeImagesJob(plugin);
    job.imageTextHeightDetector = {
        async ensureWorker() {},
        async detect() { return 16; },
        async terminate() {},
    };
    boot.setComputedFontSize("16px");
    boot.setImageLoader(() => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));

    let editApplied = false;
    plugin.app.vault.process = async (target, fn) => {
        target.__contents = userEdit;
        editApplied = true;
        const next = fn(target.__contents);
        target.__contents = next;
        return next;
    };

    const result = await job.run(makeView(file));
    await Promise.resolve();

    assert.equal(editApplied, true, "测试必须把编辑准确插入初次 read 与原子 process 之间");
    assert.equal(result.aborted, true, "提交动作必须原子校验，发现版本变化后 abort");
    assert.equal(file.__contents, userEdit, "最后一刻的用户编辑不能被 resize 覆盖");
});

test("[04] resize 中通过设置页清空缓存：结果只能全量成功或完全回滚，不能部分落盘", async () => {
    const { plugin, tab } = await bootFullPlugin();
    const controls = renderTab(tab);
    const original = "A ![[a.png]] B ![[b.png]] C ![[c.png]] D";
    const fullyResized = "A ![[a.png|400]] B ![[b.png|400]] C ![[c.png|400]] D";
    const file = { path: "note.md", __contents: original };
    plugin.__setActiveView(makeView(file));
    boot.setComputedFontSize("16px");
    boot.setImageLoader(() => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));
    boot.resetIdb();

    const recognizeEntered = deferred();
    const recognizeRelease = deferred();
    let recognizeCalls = 0;
    let workerKilled = false;
    const detector = plugin.resizeJob.imageTextHeightDetector;
    detector.spawnWorker = async () => ({
        async recognize() {
            recognizeCalls += 1;
            if (recognizeCalls === 1) return successfulOcrResult();
            if (recognizeCalls === 2) {
                recognizeEntered.resolve();
                await recognizeRelease.promise;
                if (workerKilled) throw new Error("worker terminated by clear cache");
            }
            return successfulOcrResult();
        },
        async terminate() {
            workerKilled = true;
            recognizeRelease.resolve();
        },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(4) });
    let resizePromise;
    let clearPromise;
    try {
        resizePromise = plugin.resizePicsToFontSize();
        await recognizeEntered.promise;
        clearPromise = controls.clearButton._onClick();
        await drainTasks(2);
        // 若安全实现选择拒绝/延后 clear，主动放行 OCR；若 clear 已 terminate，
        // resolve 是幂等的。这样测试不会把某一种安全策略写死。
        recognizeRelease.resolve();
        await Promise.all([resizePromise, clearPromise]);
    } finally {
        recognizeRelease.resolve();
        await Promise.allSettled([resizePromise, clearPromise].filter(Boolean));
        globalThis.fetch = originalFetch;
    }

    assert.ok(
        file.__contents === original || file.__contents === fullyResized,
        `清空缓存与 resize 交错后出现部分结果：${file.__contents}`,
    );
});

test("[05] resize 未完成时 onunload：不得在卸载后继续写文件或弹成功 Notice", async () => {
    const { plugin } = await bootFullPlugin();
    const original = "A ![[a.png]] B ![[b.png]]";
    const file = { path: "note.md", __contents: original };
    plugin.__setActiveView(makeView(file));
    boot.setComputedFontSize("16px");
    boot.setImageLoader(() => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));
    boot.resetNotices();

    const recognizeEntered = deferred();
    const recognizeRelease = deferred();
    let recognizeCalls = 0;
    let workerKilled = false;
    const detector = plugin.resizeJob.imageTextHeightDetector;
    detector.spawnWorker = async () => ({
        async recognize() {
            recognizeCalls += 1;
            if (recognizeCalls === 1) return successfulOcrResult();
            recognizeEntered.resolve();
            await recognizeRelease.promise;
            if (workerKilled) throw new Error("worker terminated by plugin unload");
            return successfulOcrResult();
        },
        async terminate() {
            workerKilled = true;
            recognizeRelease.resolve();
        },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(4) });
    let resizePromise;
    let noticesAtUnload;
    try {
        resizePromise = plugin.resizePicsToFontSize();
        await recognizeEntered.promise;
        plugin.onunload();
        noticesAtUnload = boot.noticeLog.length;
        await drainTasks(2);
        recognizeRelease.resolve();
        await resizePromise;
    } finally {
        recognizeRelease.resolve();
        if (resizePromise) await Promise.allSettled([resizePromise]);
        globalThis.fetch = originalFetch;
    }

    assert.equal(file.__contents, original, "插件卸载后旧 resize 任务不得提交部分结果");
    assert.equal(
        boot.noticeLog.length,
        noticesAtUnload,
        "插件卸载后旧 resize 任务不得再弹结果 Notice",
    );
});

test("[06] 两个并发 ensureWorker() 应共享同一次初始化", async () => {
    const { plugin } = await makePluginWithSettings();
    const detector = new ImageTextHeightDetector(plugin);
    const spawnGate = deferred();
    const worker = { async terminate() {} };
    let spawnCalls = 0;
    detector.spawnWorker = async () => {
        spawnCalls += 1;
        await spawnGate.promise;
        return worker;
    };

    let first;
    let second;
    let resolved;
    try {
        first = detector.ensureWorker();
        second = detector.ensureWorker();
        spawnGate.resolve();
        resolved = await Promise.all([first, second]);
    } finally {
        spawnGate.resolve();
        await Promise.allSettled([first, second].filter(Boolean));
        await detector.terminate();
    }

    assert.equal(spawnCalls, 1);
    assert.equal(resolved[0], worker);
    assert.equal(resolved[1], worker);
});

test("[07] terminate 尚未结束时重启 worker：旧清理不能撤销新 worker 的 Blob URL", async () => {
    const { plugin } = await makePluginWithSettings();
    const detector = new ImageTextHeightDetector(plugin);
    const terminateEntered = deferred();
    const terminateRelease = deferred();
    const secondSpawnRelease = deferred();
    const urls = [];
    let spawnCalls = 0;

    const firstWorker = {
        async terminate() {
            terminateEntered.resolve();
            await terminateRelease.promise;
        },
    };
    const secondWorker = { async terminate() {} };
    detector.spawnWorker = async () => {
        spawnCalls += 1;
        urls.push(detector._registerBlobUrl(
            Uint8Array.from([spawnCalls]),
            "application/octet-stream",
        ));
        if (spawnCalls === 1) return firstWorker;
        await secondSpawnRelease.promise;
        return secondWorker;
    };

    let terminatePromise;
    let restartPromise;
    let restartOutcome;
    let restartSettled = false;
    let newUrlSurvived = true;
    try {
        await detector.ensureWorker();
        terminatePromise = detector.terminate();
        await terminateEntered.promise;
        restartPromise = detector.ensureWorker().then(
            (worker) => ({ worker, error: null }),
            (error) => ({ worker: null, error }),
        ).finally(() => { restartSettled = true; });
        await drainTasks(2);
        terminateRelease.resolve();
        await terminatePromise;

        // 安全实现可以在 terminate 期间拒绝重启，也可以等旧清理完成后再启动。
        // 若它已经允许第二次 spawn，就在新初始化尚未完成时检查 URL 所有权。
        await waitFor(
            () => spawnCalls === 2 || restartSettled,
            "重启应被明确拒绝，或进入第二次 worker 初始化",
        );
        if (spawnCalls === 2) {
            newUrlSurvived = boot.blobRegistry.has(urls[1]);
        }
        secondSpawnRelease.resolve();
        restartOutcome = await restartPromise;
    } finally {
        terminateRelease.resolve();
        secondSpawnRelease.resolve();
        await Promise.allSettled([terminatePromise, restartPromise].filter(Boolean));
        await detector.terminate();
    }

    if (restartOutcome.error) {
        assert.doesNotMatch(
            restartOutcome.error.message,
            /internal error|内部错误/,
            "拒绝并发重启时应返回可解释的生命周期错误",
        );
    } else {
        assert.equal(newUrlSurvived, true, "旧 terminate() 只能回收旧 worker 的 URL");
    }
});

// ---------------------------------------------------------------------------
// 依赖下载 / 清空的互斥与设置页重绘
// ---------------------------------------------------------------------------

test("[08] 两次真实 downloadAll 并发调用应合并，不能重复下载", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = makeFakePlugin();
    const manager = new TesseractDependencyManager(plugin);
    const requestGate = deferred();
    let requestCalls = 0;
    boot.setRequestUrl(async () => {
        requestCalls += 1;
        await requestGate.promise;
        return { status: 200, arrayBuffer: toAB(BYTES_OK) };
    });

    const first = manager.downloadAll();
    await waitFor(() => requestCalls === 1, "第一次下载应已进入网络请求");
    const second = manager.downloadAll();
    requestGate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(requestCalls, makeAssets().length, "并发触发不能让每份资产下载两遍");
    if (secondResult !== null) {
        assert.deepEqual(secondResult, firstResult, "合并策略应共享首个任务结果");
    }
});

test("[09] 两次真实 clearCache 并发调用应合并，每个文件最多删除一次", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = makeFakePlugin();
    const manager = new TesseractDependencyManager(plugin);
    const adapter = plugin.app.vault.adapter;
    boot.resetIdb();
    for (const asset of makeAssets()) {
        await adapter.writeBinary(manager.getAssetPath(asset.name), toAB(BYTES_OK));
    }

    const removeEntered = deferred();
    const removeRelease = deferred();
    const originalRemove = adapter.remove.bind(adapter);
    const removeCounts = new Map();
    adapter.remove = async (path) => {
        removeCounts.set(path, (removeCounts.get(path) || 0) + 1);
        if (removeCounts.size === 1 && removeCounts.get(path) === 1) {
            removeEntered.resolve();
            await removeRelease.promise;
        }
        return originalRemove(path);
    };

    const first = manager.clearCache();
    await removeEntered.promise;
    const second = manager.clearCache();
    removeRelease.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    for (const count of removeCounts.values()) assert.equal(count, 1);
    if (secondResult !== null) {
        assert.deepEqual(secondResult, firstResult, "合并策略应共享首个任务结果");
    }
});

test("[10] download 正在读缓存时触发 clear：磁盘操作不得重叠", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = makeFakePlugin();
    const manager = new TesseractDependencyManager(plugin);
    const adapter = plugin.app.vault.adapter;
    boot.resetIdb();
    for (const asset of makeAssets()) {
        await adapter.writeBinary(manager.getAssetPath(asset.name), toAB(BYTES_OK));
    }

    const readEntered = deferred();
    const readRelease = deferred();
    const originalRead = adapter.readBinary.bind(adapter);
    let firstRead = true;
    adapter.readBinary = async (path) => {
        if (firstRead) {
            firstRead = false;
            readEntered.resolve();
            await readRelease.promise;
        }
        return originalRead(path);
    };
    const originalRemove = adapter.remove.bind(adapter);
    const overlappingRemoves = [];
    adapter.remove = async (path) => {
        if (manager.downloading && manager.clearing) overlappingRemoves.push(path);
        return originalRemove(path);
    };
    boot.setRequestUrl(async () => ({ status: 200, arrayBuffer: toAB(BYTES_OK) }));

    let downloadPromise;
    let clearPromise;
    try {
        downloadPromise = manager.downloadAll();
        await readEntered.promise;
        clearPromise = manager.clearCache();
        await drainTasks(2);
    } finally {
        readRelease.resolve();
        await Promise.allSettled([downloadPromise, clearPromise].filter(Boolean));
    }

    assert.deepEqual(
        overlappingRemoves,
        [],
        `download 尚未退出时 clear 已删除：${overlappingRemoves.join(", ")}`,
    );
});

test("[11] clear 正在删缓存时触发 download：磁盘操作不得重叠", async () => {
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    const plugin = makeFakePlugin();
    const manager = new TesseractDependencyManager(plugin);
    const adapter = plugin.app.vault.adapter;
    boot.resetIdb();
    for (const asset of makeAssets()) {
        await adapter.writeBinary(manager.getAssetPath(asset.name), toAB(BYTES_OK));
    }

    const removeEntered = deferred();
    const removeRelease = deferred();
    const originalRemove = adapter.remove.bind(adapter);
    let firstRemove = true;
    adapter.remove = async (path) => {
        if (firstRemove) {
            firstRemove = false;
            removeEntered.resolve();
            await removeRelease.promise;
        }
        return originalRemove(path);
    };
    const originalRead = adapter.readBinary.bind(adapter);
    const overlappingReads = [];
    adapter.readBinary = async (path) => {
        if (manager.downloading && manager.clearing) overlappingReads.push(path);
        return originalRead(path);
    };
    boot.setRequestUrl(async () => ({ status: 200, arrayBuffer: toAB(BYTES_OK) }));

    let clearPromise;
    let downloadPromise;
    try {
        clearPromise = manager.clearCache();
        await removeEntered.promise;
        downloadPromise = manager.downloadAll();
        await drainTasks(2);
    } finally {
        removeRelease.resolve();
        await Promise.allSettled([clearPromise, downloadPromise].filter(Boolean));
    }

    assert.deepEqual(
        overlappingReads,
        [],
        `clear 尚未退出时 download 已读取：${overlappingReads.join(", ")}`,
    );
});

test("[12] 下载中重绘设置页：新按钮必须继承 downloading 状态", async () => {
    const { plugin, settings } = await makePluginWithSettings();
    const tab = new ResizePicsSettingTab(plugin.app, settings);
    const operationEntered = deferred();
    const operationRelease = deferred();
    tab.deps.checkStatus = async () => ({ installed: [], missing: ["a"], total: 1 });
    tab.deps.downloadAll = async function (onProgress) {
        if (this.downloading) return null;
        this.downloading = true;
        operationEntered.resolve();
        onProgress && onProgress({ phase: "start", name: "a", current: 1, total: 1 });
        try {
            await operationRelease.promise;
            return { downloaded: 1, skipped: 0, failed: [] };
        } finally {
            this.downloading = false;
        }
    };

    const firstRender = renderTab(tab);
    let actionPromise;
    let redrawn;
    try {
        actionPromise = firstRender.downloadButton._onClick();
        await operationEntered.promise;
        redrawn = renderTab(tab);
    } finally {
        operationRelease.resolve();
        if (actionPromise) await actionPromise;
    }

    const text = settings.uiText.settingsText;
    assert.equal(redrawn.downloadButton.disabled, true);
    assert.equal(redrawn.downloadButton.text, text.downloadingButton);
    assert.equal(redrawn.clearButton.disabled, true, "下载中清空按钮也必须禁用");
});

test("[13] 清空中重绘设置页：新按钮必须继承 clearing 状态", async () => {
    const { plugin, settings } = await makePluginWithSettings();
    const tab = new ResizePicsSettingTab(plugin.app, settings);
    const operationEntered = deferred();
    const operationRelease = deferred();
    tab.deps.checkStatus = async () => ({ installed: ["a"], missing: [], total: 1 });
    tab.deps.clearCache = async function () {
        if (this.clearing) return null;
        this.clearing = true;
        operationEntered.resolve();
        try {
            await operationRelease.promise;
            return { removed: ["a"], evictedKeys: [] };
        } finally {
            this.clearing = false;
        }
    };

    const firstRender = renderTab(tab);
    let actionPromise;
    let redrawn;
    try {
        actionPromise = firstRender.clearButton._onClick();
        await operationEntered.promise;
        redrawn = renderTab(tab);
    } finally {
        operationRelease.resolve();
        if (actionPromise) await actionPromise;
    }

    const text = settings.uiText.settingsText;
    assert.equal(redrawn.clearButton.disabled, true);
    assert.equal(redrawn.clearButton.text, text.clearingButton);
    assert.equal(redrawn.downloadButton.disabled, true, "清空中下载按钮也必须禁用");
});

test("[14] 下载中重绘后：旧按钮的收尾 refresh 不能让当前状态永久停在 checking", async () => {
    const { plugin, settings } = await makePluginWithSettings();
    const tab = new ResizePicsSettingTab(plugin.app, settings);
    const downloadEntered = deferred();
    const downloadRelease = deferred();
    const visibleRefreshRelease = deferred();
    let statusCalls = 0;

    tab.deps.checkStatus = async () => {
        statusCalls += 1;
        if (statusCalls === 1) {
            return { installed: [], missing: ["a"], total: 1 };
        }
        if (statusCalls === 2) {
            await visibleRefreshRelease.promise;
        }
        return { installed: ["a"], missing: [], total: 1 };
    };
    tab.deps.downloadAll = async function () {
        this.downloading = true;
        downloadEntered.resolve();
        try {
            await downloadRelease.promise;
            return { downloaded: 1, skipped: 0, failed: [] };
        } finally {
            this.downloading = false;
        }
    };

    const firstRender = renderTab(tab);
    await waitFor(() => statusCalls === 1, "第一次页面状态检查应完成");
    let actionPromise;
    let currentRender;
    try {
        actionPromise = firstRender.downloadButton._onClick();
        await downloadEntered.promise;
        currentRender = renderTab(tab);
        await waitFor(() => statusCalls === 2, "新页面应启动自己的状态检查");

        downloadRelease.resolve();
        await actionPromise;
        assert.ok(statusCalls >= 3, "旧按钮完成后会发起一次收尾状态检查");

        visibleRefreshRelease.resolve();
        await drainTasks(2);
    } finally {
        downloadRelease.resolve();
        visibleRefreshRelease.resolve();
        if (actionPromise) await Promise.allSettled([actionPromise]);
    }

    const readyText = settings.uiText.settingsText.statusReady.replace("{total}", "1");
    assert.equal(
        currentRender.statusEl.text,
        readyText,
        "当前页面必须最终显示下载后的 ready 状态",
    );
});

// ---------------------------------------------------------------------------
// 跨模块用户操作：下载、resize、卸载与设置保存
// ---------------------------------------------------------------------------

test("[15] 设置页下载未完成时触发 resize：应立即给出进行中提示", async () => {
    const { plugin, tab } = await bootFullPlugin();
    const controls = renderTab(tab);
    const requestEntered = deferred();
    const requestRelease = deferred();
    boot.setRequestUrl(async () => {
        requestEntered.resolve();
        await requestRelease.promise;
        return { status: 503, arrayBuffer: new ArrayBuffer(0) };
    });
    const file = { path: "note.md", __contents: "![[a.png]]" };
    plugin.__setActiveView(makeView(file));
    boot.setComputedFontSize("16px");
    boot.setImageLoader(() => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));
    boot.resetNotices();

    let downloadPromise;
    let resizePromise;
    let resizeSettled = false;
    let messagesBeforeDownloadRelease = [];
    try {
        downloadPromise = controls.downloadButton._onClick();
        await requestEntered.promise;
        const noticeStart = boot.noticeLog.length;
        resizePromise = plugin.resizePicsToFontSize().finally(() => { resizeSettled = true; });
        await drainTasks(4);
        messagesBeforeDownloadRelease = boot.noticeLog
            .slice(noticeStart)
            .map((notice) => notice.message);
    } finally {
        requestRelease.resolve();
        await Promise.allSettled([downloadPromise, resizePromise].filter(Boolean));
    }

    assert.equal(resizeSettled, true, "resize 不应暗中排队到下载结束以后");
    assert.equal(messagesBeforeDownloadRelease.length, 1, "resize 应独立给出一次反馈");
    assert.match(
        messagesBeforeDownloadRelease[0],
        /正在下载|下载任务.*进行中|download.*in progress/i,
        "反馈应准确说明下载仍在进行",
    );
    assert.doesNotMatch(
        messagesBeforeDownloadRelease[0],
        /请在设置中下载|please download|依赖.*未就绪|dependencies not ready/i,
        "用户已经在下载时，不应再次要求他去下载",
    );
    assert.equal(file.__contents, "![[a.png]]");
});

test("[16] 下载未完成时 onunload：必须取消任务，且卸载后不能再弹完成 Notice", async () => {
    const { plugin, tab } = await bootFullPlugin();
    const { TesseractDependencyManager } = loadWithAssets(makeAssets());
    tab.deps = new TesseractDependencyManager(plugin);
    const controls = renderTab(tab);
    const requestEntered = deferred();
    const requestRelease = deferred();
    boot.setRequestUrl(async () => {
        requestEntered.resolve();
        await requestRelease.promise;
        return { status: 200, arrayBuffer: toAB(BYTES_OK) };
    });
    const adapter = plugin.app.vault.adapter;
    const originalWrite = adapter.writeBinary.bind(adapter);
    const writesAfterUnload = [];
    let unloading = false;
    adapter.writeBinary = async (path, bytes) => {
        if (unloading) writesAfterUnload.push(path);
        return originalWrite(path, bytes);
    };
    boot.resetNotices();

    let downloadPromise;
    let downloadingAfterUnload;
    let noticesAtUnload;
    try {
        downloadPromise = controls.downloadButton._onClick();
        await requestEntered.promise;
        unloading = true;
        plugin.onunload();
        downloadingAfterUnload = tab.deps.downloading;
        noticesAtUnload = boot.noticeLog.length;
    } finally {
        requestRelease.resolve();
        if (downloadPromise) await downloadPromise;
    }

    assert.deepEqual(
        writesAfterUnload,
        [],
        `插件卸载后旧下载仍写入：${writesAfterUnload.join(", ")}`,
    );
    assert.equal(downloadingAfterUnload, false, "onunload 应同步发出取消信号并释放状态");
    assert.equal(
        boot.noticeLog.length,
        noticesAtUnload,
        "插件卸载后，旧异步回调不应继续向用户发 Notice",
    );
});

test("[17] 快速连续切换语言且保存乱序完成：持久化结果必须是最后一次选择", async () => {
    const { plugin, settings } = await makePluginWithSettings();
    const firstSaveRelease = deferred();
    let saveCalls = 0;
    let persisted = null;
    plugin.saveData = async (value) => {
        saveCalls += 1;
        const snapshot = JSON.parse(JSON.stringify(value));
        if (saveCalls === 1) await firstSaveRelease.promise;
        persisted = snapshot;
    };

    let firstChange;
    try {
        firstChange = settings.setLanguage("en");
        await waitFor(() => saveCalls === 1, "第一次语言保存应已开始");
        await settings.setLanguage("zh-CN");
    } finally {
        firstSaveRelease.resolve();
        if (firstChange) await firstChange;
    }

    assert.equal(settings.value.language, "zh-CN", "内存状态应是最后一次选择");
    assert.equal(persisted.language, "zh-CN", "较早完成较晚的保存不能覆盖最后选择");
});

test("[18] display() 会让 pending 的旧 refreshStatus 失效", async () => {
    const { plugin, settings } = await makePluginWithSettings();
    const tab = new ResizePicsSettingTab(plugin.app, settings);
    const checkRelease = deferred();
    tab.deps.checkStatus = async () => {
        await checkRelease.promise;
        return { installed: [], missing: ["x"], total: 1 };
    };

    const orphanStatus = {
        text: "初始占位",
        classes: new Set(),
        setText(value) { this.text = value; },
        addClass(value) { this.classes.add(value); },
        removeClass(value) { this.classes.delete(value); },
    };
    const generationBefore = tab._displayGeneration;
    const oldRefresh = tab.refreshStatus(orphanStatus);
    tab.display();
    const generationAfter = tab._displayGeneration;

    checkRelease.resolve();
    await oldRefresh;
    await drainTasks(2);

    assert.ok(generationAfter > generationBefore);
    assert.equal(
        orphanStatus.text,
        "初始占位",
        "display() 丢弃旧节点后，旧检查结果不得再写它",
    );
});

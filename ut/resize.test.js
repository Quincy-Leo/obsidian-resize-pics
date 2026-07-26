/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const boot = require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ResizeImagesJob } = require("../src/resize");
const { LANGUAGE_OPTIONS } = require("../src/settings");
const { makeFakePlugin } = require("./helpers/fakePlugin");

// ---------------------------------------------------------------------------
// 测试策略
// ---------------------------------------------------------------------------
//
// rewriteContent 里唯一的运行时黑箱是 ImageTextHeightDetector：它需要
// Tesseract worker、需要 blob URL、需要 IndexedDB。这里把 job 的
// imageTextHeightDetector 直接替换成一个可控 fake（stub），返回值由每个
// 用例决定。这样可以覆盖 rewriteContent 的正常、跳过、OCR 抛错、缩放越界
// 和多位置改写分支；任务取消与提交时序由 concurrent.test.js 覆盖。

function makeJob({ imageMap = null, detectFn = null, fileCacheResolver = null } = {}) {
    const plugin = makeFakePlugin({
        fileCacheResolver,
        linkResolver: (linkpath) => {
            if (imageMap && imageMap.has(linkpath) === false) return null;
            return { path: linkpath, __contents: null };
        },
    });
    const job = new ResizeImagesJob(plugin);
    // 替换 OCR 依赖：ensureWorker 直接返回，detect 走注入的实现。
    job.imageTextHeightDetector = {
        ensureCalls: 0,
        async ensureWorker() { this.ensureCalls += 1; },
        async detect(info) {
            if (typeof detectFn === "function") return detectFn(info);
            return 16; // 默认让 scale=1（不改宽度）
        },
        async terminate() {},
    };
    // 图片尺寸 stub —— resize.js 通过 loadImageDimensions → new Image() 拿宽高。
    boot.setImageLoader((_url) => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));
    return { plugin, job };
}

/** Build exact Obsidian EmbedCache fixtures without parsing the test input. */
function makeEmbedCache(content, references) {
    const nextOffsets = new Map();
    return references.map(([original, link]) => {
        const from = nextOffsets.get(original) || 0;
        const start = content.indexOf(original, from);
        assert.notEqual(start, -1, `fixture not found in content: ${original}`);
        nextOffsets.set(original, start + original.length);
        return {
            link,
            original,
            position: {
                start: { offset: start },
                end: { offset: start + original.length },
            },
        };
    });
}

function rewriteWithCache(job, content, references, bodyFontPx = 16) {
    return job.rewriteContent(
        content,
        "note.md",
        bodyFontPx,
        makeEmbedCache(content, references),
    );
}

test("Vault.process 不可用时立即报错，不读取或写入文件", async () => {
    const plugin = makeFakePlugin();
    plugin.uiText = LANGUAGE_OPTIONS[0];
    delete plugin.app.vault.process;
    let reads = 0;
    let writes = 0;
    plugin.app.vault.read = async () => { reads += 1; return "![[a.png]]"; };
    plugin.app.vault.modify = async () => { writes += 1; };
    const job = new ResizeImagesJob(plugin);

    await assert.rejects(
        () => job.run({ file: { path: "note.md" }, containerEl: {} }),
        /Vault\.process/,
    );
    assert.equal(reads, 0);
    assert.equal(writes, 0);
});

test("wikilink 无 size：追加 size 段", async () => {
    const { job } = makeJob({ detectFn: () => 8 }); // imageTextHeight=8, bodyFont=16 ⇒ scale=2
    const src = "before ![[a.png]] after";
    const res = await rewriteWithCache(job, src, [["![[a.png]]", "a.png"]]);
    assert.equal(res.considered, 1);
    assert.equal(res.resized, 1);
    assert.equal(res.skipped, 0);
    // 400px × (16/8) = 800
    assert.equal(res.newContent, "before ![[a.png|800]] after");
});

test("wikilink 已有 size 且末段是 size：替换", async () => {
    const { job } = makeJob({ detectFn: () => 16 }); // scale=1 ⇒ newWidth=400
    const src = "![[a.png|123]]";
    const res = await rewriteWithCache(job, src, [[src, "a.png"]]);
    assert.equal(res.newContent, "![[a.png|400]]");
});

test("wikilink caption + size：保留 caption，只改 size", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const src = "![[a.png|caption|123]]";
    const res = await rewriteWithCache(job, src, [[src, "a.png"]]);
    assert.equal(res.newContent, "![[a.png|caption|400]]");
});

test("wikilink caption 但无 size：追加 size", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const src = "![[a.png|caption]]";
    const res = await rewriteWithCache(job, src, [[src, "a.png"]]);
    assert.equal(res.newContent, "![[a.png|caption|400]]");
});

test("standard image alt 为空 → 用 size 填充", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const src = "![](a.png)";
    const res = await rewriteWithCache(job, src, [[src, "a.png"]]);
    assert.equal(res.newContent, "![400](a.png)");
});

test("standard image alt 已有 size 段 → 替换末段", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const src = "![alt|123](a.png)";
    const res = await rewriteWithCache(job, src, [[src, "a.png"]]);
    assert.equal(res.newContent, "![alt|400](a.png)");
});

test("external URL 完全跳过（不计入 considered）", async () => {
    const { job } = makeJob();
    const src = "![[https://example.com/a.png]] ![](http://x.com/b.png)";
    const res = await rewriteWithCache(job, src, [
        ["![[https://example.com/a.png]]", "https://example.com/a.png"],
        ["![](http://x.com/b.png)", "http://x.com/b.png"],
    ]);
    assert.equal(res.considered, 0);
    assert.equal(res.newContent, src);
});

test("非图片扩展名 → 不计入 considered", async () => {
    const { job } = makeJob();
    const src = "![[note.md]] ![](README.txt)";
    const res = await rewriteWithCache(job, src, [
        ["![[note.md]]", "note.md"],
        ["![](README.txt)", "README.txt"],
    ]);
    assert.equal(res.considered, 0);
});

test("图片存在但 OCR 不支持的格式（svg/gif）→ considered 但 skipped", async () => {
    const { job } = makeJob();
    const src = "![[a.svg]] ![](b.gif)";
    const res = await rewriteWithCache(job, src, [
        ["![[a.svg]]", "a.svg"],
        ["![](b.gif)", "b.gif"],
    ]);
    assert.equal(res.considered, 2);
    assert.equal(res.skipped, 2);
    assert.equal(res.resized, 0);
});

test("linkpath 在 metadataCache 里解析不到 → skipped", async () => {
    const plugin = makeFakePlugin({ linkResolver: () => null });
    const job = new ResizeImagesJob(plugin);
    job.imageTextHeightDetector = {
        async ensureWorker() {}, async detect() { return 16; }, async terminate() {},
    };
    const src = "![[missing.png]]";
    const res = await rewriteWithCache(job, src, [[src, "missing.png"]]);
    assert.equal(res.considered, 1);
    assert.equal(res.skipped, 1);
    assert.equal(res.resized, 0);
});

test("Image 加载失败（naturalWidth=0）→ skipped，不触发 ensureWorker", async () => {
    const { job } = makeJob();
    boot.setImageLoader(() => ({ ok: false }));
    const src = "![[a.png]]";
    const res = await rewriteWithCache(job, src, [[src, "a.png"]]);
    assert.equal(res.considered, 1);
    assert.equal(res.skipped, 1);
    assert.equal(job.imageTextHeightDetector.ensureCalls, 0);
});

test("ensureWorker 抛错 → 冒泡出 rewriteContent，不被 per-image try 吞掉", async () => {
    const { job } = makeJob();
    job.imageTextHeightDetector.ensureWorker = async () => { throw new Error("deps missing"); };
    const src = "![[a.png]]";
    await assert.rejects(
        () => rewriteWithCache(job, src, [[src, "a.png"]]),
        /deps missing/,
    );
});

test("detect() 抛错 → 当图跳过，但 batch 继续", async () => {
    let calls = 0;
    const { job } = makeJob({
        detectFn: () => { calls += 1; if (calls === 1) throw new Error("bad image"); return 16; },
    });
    const src = "![[a.png]]\n![[b.png]]";
    const res = await rewriteWithCache(job, src, [
        ["![[a.png]]", "a.png"],
        ["![[b.png]]", "b.png"],
    ]);
    // 顺序：edits 从末尾开始 splice，所以 b.png 先处理，然后 a.png
    assert.equal(res.considered, 2);
    assert.equal(res.resized, 1);
    assert.equal(res.skipped, 1);
});

test("detect() 返回 NaN → skipped", async () => {
    const { job } = makeJob({ detectFn: () => NaN });
    const src = "![[a.png]]";
    const res = await rewriteWithCache(job, src, [[src, "a.png"]]);
    assert.equal(res.skipped, 1);
    assert.equal(res.resized, 0);
});

test("超出 [1/10, 10] 缩放比 → skipped", async () => {
    // bodyFontPx=16, imageTextHeightPx=0.1 ⇒ scale=160，超出上限
    const { job } = makeJob({ detectFn: () => 0.1 });
    const src = "![[a.png]]";
    const res = await rewriteWithCache(job, src, [[src, "a.png"]]);
    assert.equal(res.skipped, 1);
    assert.equal(res.resized, 0);
});

test("splice 从末尾往前，早期 offset 保持有效", async () => {
    // 两个 wikilink 在同一行；如果先替换前一个，后一个的 start/end 会失效。
    const { job } = makeJob({ detectFn: () => 16 });
    const src = "AAA ![[a.png]] BBB ![[b.png]] CCC";
    const res = await rewriteWithCache(job, src, [
        ["![[a.png]]", "a.png"],
        ["![[b.png]]", "b.png"],
    ]);
    assert.equal(res.newContent, "AAA ![[a.png|400]] BBB ![[b.png|400]] CCC");
    assert.equal(res.resized, 2);
});

test("URL 编码的路径也能被解析（decodeURIComponent 落地为 vault linkpath）", async () => {
    // metadataCache 里我们把 linkpath 直接当作路径回吐，
    // 只要 rewriteContent 能把 %20 解码成空格再查表即可。
    let seenLink = null;
    const plugin = makeFakePlugin({
        linkResolver: (linkpath) => { seenLink = linkpath; return { path: linkpath, __contents: null }; },
    });
    const job = new ResizeImagesJob(plugin);
    job.imageTextHeightDetector = {
        async ensureWorker() {}, async detect() { return 16; }, async terminate() {},
    };
    boot.setImageLoader(() => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));
    const src = "![](a%20b.png)";
    await rewriteWithCache(job, src, [[src, "a%20b.png"]]);
    assert.equal(seenLink, "a b.png");
});

test("只改 metadata cache 标记的正文 embed，排除 frontmatter、代码和注释", async () => {
    const src = [
        "---",
        'cover: "![[frontmatter.png]]"',
        "---",
        "",
        "`![[inline.png]]`",
        "",
        "<!-- ![[comment.png]] -->",
        "",
        "```md",
        "![[fenced.png]]",
        "```",
        "",
        "    ![[indented.png]]",
        "",
        "正文 ![[body.png]]",
    ].join("\n");
    const embeds = makeEmbedCache(src, [["![[body.png]]", "body.png"]]);
    let cachedFile = null;
    const { job } = makeJob({
        fileCacheResolver: (file) => {
            cachedFile = file;
            return { embeds };
        },
    });
    const file = { path: "note.md", __contents: src };
    const view = {
        file,
        containerEl: { querySelector: () => ({}) },
    };

    const res = await job.run(view);

    assert.equal(cachedFile, file);
    assert.equal(res.considered, 1);
    assert.equal(res.resized, 1);
    assert.equal(file.__contents, src.replace("![[body.png]]", "![[body.png|400]]"));
});

test("standard image 保留 title，并支持目标路径中的配对括号", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const withTitle = '![alt](image.png "title")';
    const withParens = "![diagram](assets/plot(1).png)";
    const src = `${withTitle}\n${withParens}`;
    const res = await rewriteWithCache(job, src, [
        [withTitle, "image.png"],
        [withParens, "assets/plot(1).png"],
    ]);

    assert.equal(res.considered, 2);
    assert.equal(res.resized, 2);
    assert.equal(
        res.newContent,
        '![alt|400](image.png "title")\n![diagram|400](assets/plot(1).png)',
    );
});

test("缓存缺失或位置陈旧时不回退全文扫描", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const src = "![[a.png]]";
    const withoutCache = await job.rewriteContent(src, "note.md", 16, undefined);
    const stale = makeEmbedCache(src, [[src, "a.png"]]);
    stale[0].original = "![[other.png]]";
    const withStaleCache = await job.rewriteContent(src, "note.md", 16, stale);

    assert.equal(withoutCache.considered, 0);
    assert.equal(withoutCache.newContent, src);
    assert.equal(withStaleCache.considered, 0);
    assert.equal(withStaleCache.newContent, src);
});

test("写入成功后调用 leaf.rebuildView() 强制视图刷新", async () => {
    // Obsidian 对源码微小变化（如 `|500` → `|1000`）经常不重算 <img>
    // 尺寸，用户就得手动切模式或切文件；写入后 rebuildView 才能把新
    // 宽度立刻反映到当前视图。
    const src = "![[a.png]]";
    const embeds = makeEmbedCache(src, [[src, "a.png"]]);
    const { job } = makeJob({
        detectFn: () => 8, // scale=2，触发实际改写
        fileCacheResolver: () => ({ embeds }),
    });
    const file = { path: "note.md", __contents: src };
    let rebuilds = 0;
    const view = {
        file,
        containerEl: { querySelector: () => ({}) },
        leaf: { rebuildView() { rebuilds += 1; } },
    };

    const res = await job.run(view);

    assert.equal(res.resized, 1);
    assert.equal(res.aborted, false);
    assert.equal(file.__contents, "![[a.png|800]]");
    assert.equal(rebuilds, 1);
});

test("内容未变化时不调用 rebuildView", async () => {
    // 已经是目标宽度，rewriteContent 不改任何字符，跳过写入分支自然
    // 也应该跳过 rebuildView —— 避免无实际修改时白白重建视图。
    const src = "![[a.png|400]]";
    const embeds = makeEmbedCache(src, [[src, "a.png"]]);
    const { job } = makeJob({
        detectFn: () => 16, // scale=1，newWidth=400，与已有值一致
        fileCacheResolver: () => ({ embeds }),
    });
    const file = { path: "note.md", __contents: src };
    let rebuilds = 0;
    const view = {
        file,
        containerEl: { querySelector: () => ({}) },
        leaf: { rebuildView() { rebuilds += 1; } },
    };

    const res = await job.run(view);

    assert.equal(res.resized, 1);
    assert.equal(res.aborted, false);
    assert.equal(file.__contents, src);
    assert.equal(rebuilds, 0);
});

test("rebuildView 抛错不会让整个 run 报错", async () => {
    // rebuildView 是 Obsidian 的非文档 API，未来可能移除或改签名；
    // 即使它抛错，写入已经成功，run 应该照常返回成功结果，不能把
    // 一次成功的 resize 变成失败上报给用户。
    const src = "![[a.png]]";
    const embeds = makeEmbedCache(src, [[src, "a.png"]]);
    const { job } = makeJob({
        detectFn: () => 8,
        fileCacheResolver: () => ({ embeds }),
    });
    const file = { path: "note.md", __contents: src };
    const view = {
        file,
        containerEl: { querySelector: () => ({}) },
        leaf: { rebuildView() { throw new Error("boom"); } },
    };

    const res = await job.run(view);

    assert.equal(res.resized, 1);
    assert.equal(res.aborted, false);
    assert.equal(file.__contents, "![[a.png|800]]");
});

test("leaf.rebuildView 不存在时不报错", async () => {
    // 老版本 Obsidian 或未来的 API 变动可能让 rebuildView 消失；缺失
    // 时应该静默跳过刷新而不是抛错。
    const src = "![[a.png]]";
    const embeds = makeEmbedCache(src, [[src, "a.png"]]);
    const { job } = makeJob({
        detectFn: () => 8,
        fileCacheResolver: () => ({ embeds }),
    });
    const file = { path: "note.md", __contents: src };
    const view = {
        file,
        containerEl: { querySelector: () => ({}) },
        leaf: {}, // no rebuildView
    };

    const res = await job.run(view);

    assert.equal(res.resized, 1);
    assert.equal(res.aborted, false);
    assert.equal(file.__contents, "![[a.png|800]]");
});

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

/**
 * Build a minimal SectionCache list from a plain `{type, from, to}` spec, where
 * `from`/`to` are literal substrings whose earliest occurrence in `content`
 * anchors the section. Tests use this to hand `rewriteContent` the exact
 * section coverage they need without shipping a real Markdown parser.
 */
function makeSectionCache(content, specs) {
    return specs.map(({ type, from, to }) => {
        const start = content.indexOf(from);
        assert.notEqual(start, -1, `section start not found: ${from}`);
        const toIdx = content.indexOf(to, start);
        assert.notEqual(toIdx, -1, `section end not found: ${to}`);
        return {
            type,
            position: {
                start: { offset: start },
                end: { offset: toIdx + to.length },
            },
        };
    });
}

/** Single paragraph section that spans the whole content string. */
function wholeParagraphSections(content) {
    return [{
        type: "paragraph",
        position: {
            start: { offset: 0 },
            end: { offset: content.length },
        },
    }];
}

/** requestUrl stub returning a fixed 2xx body every call. */
function stubRequestUrlOk() {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    let calls = 0;
    boot.setRequestUrl(async () => {
        calls += 1;
        return { status: 200, arrayBuffer: bytes };
    });
    return () => calls;
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

// ---------------------------------------------------------------------------
// 外链图片：走 cache.sections 发现 + requestUrl 下载 + OCR
// ---------------------------------------------------------------------------
//
// 所有外链用例都必须先把 job._externalFetchBackoffMs 归零，否则重试测试要
// 等真实 setTimeout。同时用 makeSectionCache 精确控制哪些 offset 属于
// paragraph/code/yaml/... —— 我们不复用一个 Markdown 解析器，就靠这个 stub
// 逐条覆盖 EXTERNAL_IMAGES_NOTES.md 里列的安全 / 不安全 section 类型。

test("外链 paragraph 内的 image → 下载 + OCR + 改写", async () => {
    const src = "看这张图 ![alt](https://ex.com/a.png) 结束";
    const { job } = makeJob({ detectFn: () => 8 }); // scale=2 → newWidth=800
    job._externalFetchBackoffMs = 0;
    const requestCount = stubRequestUrlOk();

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(res.considered, 1);
    assert.equal(res.resized, 1);
    assert.equal(res.skipped, 0);
    assert.equal(res.newContent, "看这张图 ![alt|800](https://ex.com/a.png) 结束");
    assert.equal(requestCount(), 1, "成功一次不应重试");
});

test("外链空 alt / 已有 size / caption + size 都能正确改写", async () => {
    const emptyAlt = "![](https://ex.com/a.png)";
    const withSize = "![alt|123](https://ex.com/b.png)";
    const withCap = "![alt|caption|123](https://ex.com/c.png)";
    const src = `${emptyAlt}\n${withSize}\n${withCap}`;
    const { job } = makeJob({ detectFn: () => 16 }); // scale=1 → newWidth=400
    job._externalFetchBackoffMs = 0;
    stubRequestUrlOk();

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(res.considered, 3);
    assert.equal(res.resized, 3);
    assert.equal(res.newContent, [
        "![400](https://ex.com/a.png)",
        "![alt|400](https://ex.com/b.png)",
        "![alt|caption|400](https://ex.com/c.png)",
    ].join("\n"));
});

test("外链保留 title，只改 alt 中的 size", async () => {
    const src = '![alt](https://ex.com/a.png "cap")';
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    stubRequestUrlOk();

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(res.resized, 1);
    assert.equal(res.newContent, '![alt|800](https://ex.com/a.png "cap")');
});

test("外链 URL 带 query/fragment → 从 pathname 判断扩展名", async () => {
    const isImg = "![](https://ex.com/a.png?v=2#anchor)";
    const notImg = "![](https://ex.com/api?type=png)";
    const src = `${isImg}\n${notImg}`;
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    const requestCount = stubRequestUrlOk();

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    // notImg 的 pathname 是 "/api"，IMAGE_EXT_RE 不匹配 → 不计 considered
    assert.equal(res.considered, 1);
    assert.equal(res.resized, 1);
    assert.equal(requestCount(), 1, "api URL 不应触发下载");
    assert.equal(res.newContent, `![800](https://ex.com/a.png?v=2#anchor)\n${notImg}`);
});

test("外链下载 URL 保持原样（不做 decodeURIComponent）", async () => {
    // %20 在真实 URL 里代表空格，但请求方要收到 %20 —— 若被 decode 成空格
    // 服务器就找不到资源。
    const src = "![](https://ex.com/a%20b.png)";
    const { job } = makeJob({ detectFn: () => 16 });
    job._externalFetchBackoffMs = 0;
    let seenUrl = null;
    boot.setRequestUrl(async ({ url }) => {
        seenUrl = url;
        return { status: 200, arrayBuffer: new ArrayBuffer(4) };
    });

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(res.resized, 1);
    assert.equal(seenUrl, "https://ex.com/a%20b.png");
});

test("外链 OCR-不支持格式（svg/gif/avif）→ considered=+1, skipped=+1，无下载", async () => {
    const src = [
        "![](https://ex.com/vec.svg)",
        "![](https://ex.com/anim.gif)",
        "![](https://ex.com/img.avif)",
    ].join("\n");
    const { job } = makeJob();
    job._externalFetchBackoffMs = 0;
    let requestCalls = 0;
    boot.setRequestUrl(async () => { requestCalls += 1; return { status: 200, arrayBuffer: new ArrayBuffer(4) }; });

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(res.considered, 3);
    assert.equal(res.skipped, 3);
    assert.equal(res.resized, 0);
    assert.equal(requestCalls, 0, "OCR 不支持的格式不应发起下载");
    assert.equal(res.newContent, src);
});

test("外链 requestUrl 前两次失败第三次成功 → 恰好 3 次调用并 resize", async () => {
    const src = "![](https://ex.com/a.png)";
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    let calls = 0;
    boot.setRequestUrl(async () => {
        calls += 1;
        if (calls < 3) return { status: 500, arrayBuffer: new ArrayBuffer(0) };
        return { status: 200, arrayBuffer: new ArrayBuffer(4) };
    });

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(calls, 3);
    assert.equal(res.considered, 1);
    assert.equal(res.resized, 1);
    assert.equal(res.newContent, "![800](https://ex.com/a.png)");
});

test("外链 requestUrl 三次全 500 → skipped=1，batch 其余图不受影响", async () => {
    const src = [
        "![](https://ex.com/bad.png)",
        "",
        "![](https://ex.com/good.png)",
    ].join("\n");
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    let badCalls = 0;
    boot.setRequestUrl(async ({ url }) => {
        if (url.includes("bad.png")) {
            badCalls += 1;
            return { status: 500, arrayBuffer: new ArrayBuffer(0) };
        }
        return { status: 200, arrayBuffer: new ArrayBuffer(4) };
    });

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(badCalls, 3, "失败的图应恰好尝试 3 次");
    assert.equal(res.considered, 2);
    assert.equal(res.resized, 1);
    assert.equal(res.skipped, 1);
    assert.match(res.newContent, /good\.png\)/);
    assert.ok(res.newContent.includes("![](https://ex.com/bad.png)"), "失败图应保持原文");
});

test("外链 requestUrl 抛错三次 → skipped，且捕获 exception 不冒泡", async () => {
    const src = "![](https://ex.com/a.png)";
    const { job } = makeJob();
    job._externalFetchBackoffMs = 0;
    let calls = 0;
    boot.setRequestUrl(async () => { calls += 1; throw new Error("net down"); });

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(calls, 3);
    assert.equal(res.skipped, 1);
    assert.equal(res.resized, 0);
});

test("外链 200 空 body 视为失败并重试", async () => {
    const src = "![](https://ex.com/a.png)";
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    let calls = 0;
    boot.setRequestUrl(async () => {
        calls += 1;
        return { status: 200, arrayBuffer: new ArrayBuffer(0) };
    });

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(calls, 3);
    assert.equal(res.skipped, 1);
});

test("外链下载成功但 Image 加载失败 → skipped，不触发 detect", async () => {
    const src = "![](https://ex.com/a.png)";
    const { job } = makeJob();
    job._externalFetchBackoffMs = 0;
    stubRequestUrlOk();
    // blob URL 加载失败：Image.onerror 触发 → null dims
    boot.setImageLoader((url) => {
        if (String(url).startsWith("blob:")) return { ok: false };
        return { ok: true, naturalWidth: 400, naturalHeight: 200 };
    });
    let detectCalls = 0;
    job.imageTextHeightDetector.detect = async () => { detectCalls += 1; return 8; };

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(res.considered, 1);
    assert.equal(res.skipped, 1);
    assert.equal(res.resized, 0);
    assert.equal(detectCalls, 0, "dims 失败应直接跳过，不调用 detect");
});

test("外链 detect 收到 Uint8Array bytes，本地 detect 收到 bytes=null", async () => {
    const localOnly = "![[a.png]]";
    const external = "![](https://ex.com/e.png)";
    const src = `${localOnly}\n${external}`;
    const seenInfos = [];
    const { job } = makeJob({
        detectFn: (info) => { seenInfos.push(info); return 8; },
    });
    job._externalFetchBackoffMs = 0;
    stubRequestUrlOk();
    const embeds = makeEmbedCache(src, [[localOnly, "a.png"]]);
    const sections = wholeParagraphSections(src);

    await job.rewriteContent(src, "note.md", 16, embeds, sections);

    assert.equal(seenInfos.length, 2);
    // 因为 splice 从末尾往前处理，external 先，local 后。
    const externalInfo = seenInfos.find((info) => info.bytes);
    const localInfo = seenInfos.find((info) => !info.bytes);
    assert.ok(externalInfo, "外链 info 应有 bytes 字段");
    assert.ok(externalInfo.bytes instanceof Uint8Array);
    assert.equal(externalInfo.resourcePath, null);
    assert.ok(localInfo, "本地 info 应存在");
    assert.ok(localInfo.tfile, "本地 info 应有 tfile");
    assert.ok(localInfo.resourcePath, "本地 info 应有 resourcePath");
});

test("本地图 + 外链图混排 → 都改写，且 splice 顺序正确", async () => {
    const src = "AAA ![[a.png]] BBB ![](https://ex.com/b.png) CCC";
    const embeds = makeEmbedCache(src, [["![[a.png]]", "a.png"]]);
    const sections = wholeParagraphSections(src);
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    stubRequestUrlOk();

    const res = await job.rewriteContent(src, "note.md", 16, embeds, sections);

    assert.equal(res.considered, 2);
    assert.equal(res.resized, 2);
    assert.equal(
        res.newContent,
        "AAA ![[a.png|800]] BBB ![800](https://ex.com/b.png) CCC",
    );
});

test("非白名单 section（yaml / code / html / comment / heading）里的外链 → 不改", async () => {
    const src = [
        "---",                             // 0
        '"![](https://ex.com/y.png)"',     // yaml
        "---",
        "",
        "# ![](https://ex.com/h.png)",     // heading
        "",
        "<!-- ![](https://ex.com/c.png) -->",
        "",
        "```",
        "![](https://ex.com/f.png)",       // code
        "```",
        "",
        "<div>![](https://ex.com/r.png)</div>", // html
    ].join("\n");
    const sections = [
        { type: "yaml", from: "---", to: "---" },
        { type: "heading", from: "# ![](https://ex.com/h.png)", to: "png)" },
        { type: "comment", from: "<!--", to: "-->" },
        { type: "code", from: "```", to: "```" },
        { type: "html", from: "<div>", to: "</div>" },
    ].map((spec) => {
        // 用带索引的手工版避免 makeSectionCache 的 indexOf 撞名重复。
        const start = src.indexOf(spec.from);
        const secondIdx = spec.from === "---" || spec.from === "```"
            ? src.indexOf(spec.to, start + spec.from.length)
            : src.indexOf(spec.to, start);
        assert.notEqual(start, -1);
        assert.notEqual(secondIdx, -1);
        return {
            type: spec.type,
            position: {
                start: { offset: start },
                end: { offset: secondIdx + spec.to.length },
            },
        };
    });
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    let requestCalls = 0;
    boot.setRequestUrl(async () => { requestCalls += 1; return { status: 200, arrayBuffer: new ArrayBuffer(4) }; });

    const res = await job.rewriteContent(src, "note.md", 16, undefined, sections);

    assert.equal(res.considered, 0);
    assert.equal(res.newContent, src);
    assert.equal(requestCalls, 0);
});

test("callout / list / blockquote section 内的外链 → 都可扫", async () => {
    const src = [
        "- ![](https://ex.com/li.png)",
        "",
        "> ![](https://ex.com/bq.png)",
        "",
        "> [!note] ![](https://ex.com/cal.png)",
    ].join("\n");
    const sections = [
        { type: "list", from: "- ![](https://ex.com/li.png)", to: "png)" },
        { type: "blockquote", from: "> ![](https://ex.com/bq.png)", to: "png)" },
        { type: "callout", from: "> [!note]", to: "cal.png)" },
    ].map((spec) => {
        const start = src.indexOf(spec.from);
        const endIdx = src.indexOf(spec.to, start);
        return {
            type: spec.type,
            position: {
                start: { offset: start },
                end: { offset: endIdx + spec.to.length },
            },
        };
    });
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    stubRequestUrlOk();

    const res = await job.rewriteContent(src, "note.md", 16, undefined, sections);

    assert.equal(res.considered, 3);
    assert.equal(res.resized, 3);
});

test("paragraph 内的反引号 span 不参与外链扫描", async () => {
    // markdown 教程里的 `![](https://…)` 是文档示例，不能被改写。
    const src = "语法示例 `![](https://ex.com/x.png)` 真图 ![](https://ex.com/y.png)";
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    const requestUrls = [];
    boot.setRequestUrl(async ({ url }) => {
        requestUrls.push(url);
        return { status: 200, arrayBuffer: new ArrayBuffer(4) };
    });

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(res.considered, 1);
    assert.equal(res.resized, 1);
    assert.deepEqual(requestUrls, ["https://ex.com/y.png"]);
    assert.ok(
        res.newContent.includes("`![](https://ex.com/x.png)`"),
        "反引号内的示例应完整保留",
    );
});

test("外链 file:// / app:// / data: URL → 不参与外链扫描", async () => {
    const src = [
        "![](file:///a.png)",
        "![](app://vault/b.png)",
        "![](data:image/png;base64,AAA=)",
    ].join("\n");
    const { job } = makeJob();
    job._externalFetchBackoffMs = 0;
    let requestCalls = 0;
    boot.setRequestUrl(async () => { requestCalls += 1; return { status: 200, arrayBuffer: new ArrayBuffer(4) }; });

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(res.considered, 0);
    assert.equal(requestCalls, 0);
    assert.equal(res.newContent, src);
});

test("sections 缺失 → 外链不扫（保持既有安全语义）", async () => {
    const src = "![](https://ex.com/a.png)";
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    let requestCalls = 0;
    boot.setRequestUrl(async () => { requestCalls += 1; return { status: 200, arrayBuffer: new ArrayBuffer(4) }; });

    const res = await job.rewriteContent(src, "note.md", 16, undefined, undefined);

    assert.equal(res.considered, 0);
    assert.equal(requestCalls, 0);
    assert.equal(res.newContent, src);
});

test("同一 URL 重复引用 → 各自独立下载（不做请求级去重）", async () => {
    const src = "![](https://ex.com/a.png) 又是它 ![](https://ex.com/a.png)";
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    const requestCount = stubRequestUrlOk();

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(res.considered, 2);
    assert.equal(res.resized, 2);
    assert.equal(requestCount(), 2);
});

test("URL 里含 `)` → 正则截断，安全跳过", async () => {
    // Wikipedia 风格链接：pathname 里带未转义的 `)`。既有正则会把 URL 截到
    // 第一个 `)`，导致 match[0] 与 content.slice(start, end) 不一致，整个
    // 引用被丢弃 —— 内容原样保留，也不会发起错误请求。
    const src = "![](https://en.wikipedia.org/wiki/Foo_(bar).png)";
    const { job } = makeJob({ detectFn: () => 8 });
    job._externalFetchBackoffMs = 0;
    let requestCalls = 0;
    boot.setRequestUrl(async () => { requestCalls += 1; return { status: 200, arrayBuffer: new ArrayBuffer(4) }; });

    const res = await job.rewriteContent(
        src, "note.md", 16, undefined, wholeParagraphSections(src),
    );

    assert.equal(res.considered, 0);
    assert.equal(requestCalls, 0);
    assert.equal(res.newContent, src);
});

test("run() 从 metadataCache 抽 sections 并透传到 rewriteContent", async () => {
    // 集成风格：从 run() 入口进，验证 sections 通路完整。
    const src = "正文 ![](https://ex.com/x.png)";
    const embeds = [];
    const sections = wholeParagraphSections(src);
    const { job, plugin } = makeJob({
        detectFn: () => 8,
        fileCacheResolver: () => ({ embeds, sections }),
    });
    job._externalFetchBackoffMs = 0;
    stubRequestUrlOk();
    const file = { path: "note.md", __contents: src };
    const view = { file, containerEl: { querySelector: () => ({}) } };

    const res = await job.run(view);

    assert.equal(res.considered, 1);
    assert.equal(res.resized, 1);
    assert.equal(file.__contents, "正文 ![800](https://ex.com/x.png)");
});

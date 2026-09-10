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
// 这里只覆盖 ResizeImagesJob 自己的职责：
//   · Markdown 语法回写（wikilink / standard 两种，size 段插入/替换）
//   · OCR 集成（ensureWorker 懒起、detect 异常 / NaN / 越界的记账）
//   · run() 通往 vault.process 的原子写入、leaf.rebuildView 兜底
//   · 本地 + 外链图混排时 ResizeImagesJob 的记账（不重复测发现/下载）
//
// 图片发现 (collectReferences) 和字节获取 (resolve) 都在 getPics.test.js
// 里独立覆盖 —— 这里遇到外链/section-scan 相关分支，只用最小 fixture 验证
// ResizeImagesJob 能正确把 PicSource 的结果拼进结果里。

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
    // 图片尺寸 stub —— PicSource 会 new Image() 或从 blob URL 取尺寸。
    boot.setImageLoader((_url) => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));
    // 外链重试测试用 backoff=0，避免真实 setTimeout 等待。
    job._externalFetchBackoffMs = 0;
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

/** One `table` section covering `tableText`, plus optional paragraph sections. */
function sectionsWithTable(content, tableText, paragraphTexts = []) {
    const sectionFor = (type, text) => {
        const start = content.indexOf(text);
        assert.notEqual(start, -1, `section fixture not found in content: ${text}`);
        return {
            type,
            position: {
                start: { offset: start },
                end: { offset: start + text.length },
            },
        };
    };
    return [sectionFor("table", tableText)]
        .concat(paragraphTexts.map((text) => sectionFor("paragraph", text)));
}

function rewriteWithSections(job, content, references, sections, bodyFontPx = 16) {
    return job.rewriteContent(
        content,
        "note.md",
        bodyFontPx,
        makeEmbedCache(content, references),
        sections,
    );
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

// ---------------------------------------------------------------------------
// run() 前置校验
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Markdown 语法回写（wikilink / standard）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 表格单元格内的回写：竖线必须转义
// ---------------------------------------------------------------------------
//
// 表格里 `|` 是列分隔符，裸写 `![[a.png|800]]` 会把单元格切成两半、行的列数
// 超出表头，图片引用就断了。Obsidian 要求写成 `![[a.png\|800]]`。
// 判定依据是 CachedMetadata.sections 里 type==="table" 的 section 范围 ——
// 不用「行首是不是 `|`」的启发式：省略首尾竖线的表格会漏判，而正文里以竖线
// 开头的行会误判。

const TABLE_HEAD = "| col A | col B |\n| --- | --- |\n";

test("表格内 wikilink 首次插入 size：竖线转义", async () => {
    const { job } = makeJob({ detectFn: () => 8 }); // scale=2 ⇒ 400×2=800
    const table = `${TABLE_HEAD}| text | ![[a.png]] |`;
    const res = await rewriteWithSections(
        job, table, [["![[a.png]]", "a.png"]], sectionsWithTable(table, table),
    );
    assert.equal(res.resized, 1);
    assert.equal(res.newContent, `${TABLE_HEAD}| text | ![[a.png\\|800]] |`);
});

test("表格内 standard image 有 alt：竖线转义", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const table = `${TABLE_HEAD}| text | ![alt](a.png) |`;
    const res = await rewriteWithSections(
        job, table, [["![alt](a.png)", "a.png"]], sectionsWithTable(table, table),
    );
    assert.equal(res.newContent, `${TABLE_HEAD}| text | ![alt\\|400](a.png) |`);
});

test("表格内 standard image 空 alt：size 直接填进 alt，不产生竖线", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const table = `${TABLE_HEAD}| text | ![](a.png) |`;
    const res = await rewriteWithSections(
        job, table, [["![](a.png)", "a.png"]], sectionsWithTable(table, table),
    );
    assert.equal(res.newContent, `${TABLE_HEAD}| text | ![400](a.png) |`);
});

test("表格内已转义的 size 被替换：反斜杠不累积（二次运行幂等）", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const table = `${TABLE_HEAD}| text | ![[a.png\\|123]] |`;
    const res = await rewriteWithSections(
        job, table, [["![[a.png\\|123]]", "a.png"]], sectionsWithTable(table, table),
    );
    assert.equal(res.newContent, `${TABLE_HEAD}| text | ![[a.png\\|400]] |`);
});

test("表格内 caption + 已转义 size：caption 保留，两个分隔符都转义", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const table = `${TABLE_HEAD}| text | ![[a.png\\|caption\\|123]] |`;
    const res = await rewriteWithSections(
        job, table, [["![[a.png\\|caption\\|123]]", "a.png"]], sectionsWithTable(table, table),
    );
    assert.equal(res.newContent, `${TABLE_HEAD}| text | ![[a.png\\|caption\\|400]] |`);
});

test("表格内用户手写的裸 size 被顺带修正成转义形式", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const table = `${TABLE_HEAD}| text | ![[a.png|123]] |`;
    const res = await rewriteWithSections(
        job, table, [["![[a.png|123]]", "a.png"]], sectionsWithTable(table, table),
    );
    assert.equal(res.newContent, `${TABLE_HEAD}| text | ![[a.png\\|400]] |`);
});

test("同一篇里表格内转义、表格外保持裸竖线", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const table = `${TABLE_HEAD}| text | ![[a.png]] |`;
    const tail = "正文 ![[b.png]] 结束";
    const src = `${table}\n\n${tail}`;
    const res = await rewriteWithSections(job, src, [
        ["![[a.png]]", "a.png"],
        ["![[b.png]]", "b.png"],
    ], sectionsWithTable(src, table, [tail]));
    assert.equal(res.resized, 2);
    assert.equal(
        res.newContent,
        `${TABLE_HEAD}| text | ![[a.png\\|400]] |\n\n正文 ![[b.png|400]] 结束`,
    );
});

test("sections 缺失时退回裸竖线（不猜测表格，保持既有行为）", async () => {
    const { job } = makeJob({ detectFn: () => 16 });
    const table = `${TABLE_HEAD}| text | ![[a.png]] |`;
    const res = await rewriteWithCache(job, table, [["![[a.png]]", "a.png"]]);
    assert.equal(res.newContent, `${TABLE_HEAD}| text | ![[a.png|400]] |`);
});

// ---------------------------------------------------------------------------
// ResizeImagesJob 的记账：PicSource 结果 → considered/skipped/resized
// ---------------------------------------------------------------------------
//
// 这几条测试通过 PicSource 的真实行为来观察记账，但不去覆盖 PicSource 内部
// 逻辑（那部分在 getPics.test.js 里详测）。

test("PicSource.IGNORE → 既不 considered 也不 skipped", async () => {
    const { job } = makeJob();
    // 非图片扩展名（.md / .txt）会被 PicSource 判为 IGNORE。
    const src = "![[note.md]] ![](README.txt)";
    const res = await rewriteWithCache(job, src, [
        ["![[note.md]]", "note.md"],
        ["![](README.txt)", "README.txt"],
    ]);
    assert.equal(res.considered, 0);
});

test("PicSource.SKIP → considered=+1、skipped=+1（OCR 不支持的格式）", async () => {
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

test("linkpath 在 metadataCache 里解析不到 → considered+skipped", async () => {
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

test("Image 加载失败 → skipped，不触发 ensureWorker", async () => {
    const { job } = makeJob();
    boot.setImageLoader(() => ({ ok: false }));
    const src = "![[a.png]]";
    const res = await rewriteWithCache(job, src, [[src, "a.png"]]);
    assert.equal(res.considered, 1);
    assert.equal(res.skipped, 1);
    assert.equal(job.imageTextHeightDetector.ensureCalls, 0);
});

// ---------------------------------------------------------------------------
// OCR worker 集成：ensureWorker + detect 的错误分支
// ---------------------------------------------------------------------------

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

test("detect 拿到外链 bytes、本地 bytes=null（验证 PicSource 交接）", async () => {
    const localOnly = "![[a.png]]";
    const external = "![](https://ex.com/e.png)";
    const src = `${localOnly}\n${external}`;
    const seenInfos = [];
    const { job } = makeJob({
        detectFn: (info) => { seenInfos.push(info); return 8; },
    });
    stubRequestUrlOk();
    const embeds = makeEmbedCache(src, [[localOnly, "a.png"]]);
    const sections = wholeParagraphSections(src);

    await job.rewriteContent(src, "note.md", 16, embeds, sections);

    assert.equal(seenInfos.length, 2);
    const externalInfo = seenInfos.find((info) => info.bytes);
    const localInfo = seenInfos.find((info) => !info.bytes);
    assert.ok(externalInfo && externalInfo.bytes instanceof Uint8Array);
    assert.equal(externalInfo.resourcePath, null);
    assert.ok(localInfo && localInfo.tfile && localInfo.resourcePath);
});

// ---------------------------------------------------------------------------
// run() 端到端：cache 读取 + vault.process + rebuildView 兜底
// ---------------------------------------------------------------------------

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

test("run() 从 metadataCache 抽 sections 并透传到 rewriteContent（外链集成）", async () => {
    const src = "正文 ![](https://ex.com/x.png)";
    const embeds = [];
    const sections = wholeParagraphSections(src);
    const { job } = makeJob({
        detectFn: () => 8,
        fileCacheResolver: () => ({ embeds, sections }),
    });
    stubRequestUrlOk();
    const file = { path: "note.md", __contents: src };
    const view = { file, containerEl: { querySelector: () => ({}) } };

    const res = await job.run(view);

    assert.equal(res.considered, 1);
    assert.equal(res.resized, 1);
    assert.equal(file.__contents, "正文 ![800](https://ex.com/x.png)");
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

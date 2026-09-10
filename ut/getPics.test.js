/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const boot = require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    PicSource,
    RESOLVE_OK,
    RESOLVE_SKIP,
    RESOLVE_IGNORE,
    RESOLVE_CANCELLED,
} = require("../src/getPics");
const { makeFakePlugin } = require("./helpers/fakePlugin");

// ---------------------------------------------------------------------------
// 测试策略
// ---------------------------------------------------------------------------
//
// getPics.js 的两个职责各独立测：
//   1. collectReferences(embeds, sections)  — 纯字符串解析，不需要 job/OCR。
//   2. resolve(edit)                        — 走 vault / requestUrl 拉取字节，
//      通过 boot.setImageLoader / boot.setRequestUrl 桩注入 I/O。
//
// 用 fakePlugin 只是为了拿到 app.metadataCache / app.vault stub；PicSource 自
// 己不 new plugin。

function makePicSource({ imageMap = null, isCancelled = null, backoffMs = 0 } = {}) {
    const plugin = makeFakePlugin({
        linkResolver: (linkpath) => {
            if (imageMap && imageMap.has(linkpath) === false) return null;
            return { path: linkpath, __contents: null };
        },
    });
    boot.setImageLoader(() => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));
    return new PicSource(plugin.app, {
        isCancelled: isCancelled || (() => false),
        backoffMs,
    });
}

/** Build EmbedCache fixtures without parsing the test input. */
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

// ---------------------------------------------------------------------------
// collectReferences —— 从 embeds / sections 生成 edit 列表
// ---------------------------------------------------------------------------

test("collectReferences: 从 embeds 里认出 wikilink 与 standard 两种本地图", () => {
    const src = "![[a.png]] and ![alt](b.png)";
    const src2 = new PicSource({}, {});
    const edits = src2.collectReferences(src, makeEmbedCache(src, [
        ["![[a.png]]", "a.png"],
        ["![alt](b.png)", "b.png"],
    ]));
    assert.equal(edits.length, 2);
    // splice 从末尾往前，所以 b.png 先 —— start 更大在前。
    assert.deepEqual(edits.map((e) => e.kind), ["standard", "wikilink"]);
    assert.equal(edits[0].link, "b.png");
    assert.equal(edits[1].link, "a.png");
});

test("collectReferences: 陈旧 embed 位置对不上原文 → 直接丢弃", () => {
    const src = "![[a.png]]";
    const stale = makeEmbedCache(src, [[src, "a.png"]]);
    stale[0].original = "![[other.png]]";
    const edits = new PicSource({}, {}).collectReferences(src, stale);
    assert.deepEqual(edits, []);
});

test("collectReferences: embeds 缺失 → 结果为空，不做全文扫", () => {
    const src = "看图 ![[a.png]] 结束";
    const edits = new PicSource({}, {}).collectReferences(src, undefined);
    assert.deepEqual(edits, []);
});

test("collectReferences: sections 里的 https 外链会被扫为 standard/external 记录", () => {
    const src = "开头 ![alt](https://ex.com/a.png) 结尾";
    const edits = new PicSource({}, {}).collectReferences(
        src, undefined, wholeParagraphSections(src),
    );
    assert.equal(edits.length, 1);
    assert.equal(edits[0].kind, "standard");
    assert.equal(edits[0].external, true);
    assert.equal(edits[0].link, "https://ex.com/a.png");
    assert.equal(edits[0].alt, "alt");
});

test("collectReferences: sections 缺失 → 外链不扫（保持既有安全语义）", () => {
    const src = "![](https://ex.com/a.png)";
    const edits = new PicSource({}, {}).collectReferences(src, undefined, undefined);
    assert.deepEqual(edits, []);
});

test("collectReferences: 非白名单 section（yaml/code/html/comment/heading）内的外链不扫", () => {
    const src = [
        "---",                                    // yaml
        '"![](https://ex.com/y.png)"',
        "---",
        "",
        "# ![](https://ex.com/h.png)",           // heading
        "",
        "<!-- ![](https://ex.com/c.png) -->",   // comment
        "",
        "```",
        "![](https://ex.com/f.png)",             // code
        "```",
        "",
        "<div>![](https://ex.com/r.png)</div>", // html
    ].join("\n");
    const sections = [
        { type: "yaml",     from: "---",                          to: "---" },
        { type: "heading",  from: "# ![](https://ex.com/h.png)",  to: "png)" },
        { type: "comment",  from: "<!--",                          to: "-->" },
        { type: "code",     from: "```",                           to: "```" },
        { type: "html",     from: "<div>",                         to: "</div>" },
    ].map((spec) => {
        const start = src.indexOf(spec.from);
        const endIdx = spec.from === "---" || spec.from === "```"
            ? src.indexOf(spec.to, start + spec.from.length)
            : src.indexOf(spec.to, start);
        return {
            type: spec.type,
            position: {
                start: { offset: start },
                end: { offset: endIdx + spec.to.length },
            },
        };
    });
    const edits = new PicSource({}, {}).collectReferences(src, undefined, sections);
    assert.deepEqual(edits, []);
});

test("collectReferences: paragraph 内的反引号 span 被屏蔽，只扫真图", () => {
    const src = "语法示例 `![](https://ex.com/x.png)` 真图 ![](https://ex.com/y.png)";
    const edits = new PicSource({}, {}).collectReferences(
        src, undefined, wholeParagraphSections(src),
    );
    assert.equal(edits.length, 1);
    assert.equal(edits[0].link, "https://ex.com/y.png");
});

test("collectReferences: URL 里含未转义 `)` → 正则截断，safe skip", () => {
    // Wikipedia 风格链接会被 [^\s()] 提前截断 → match[0] 与原文对不上 → 丢弃。
    const src = "![](https://en.wikipedia.org/wiki/Foo_(bar).png)";
    const edits = new PicSource({}, {}).collectReferences(
        src, undefined, wholeParagraphSections(src),
    );
    assert.deepEqual(edits, []);
});

test("collectReferences: 非 http(s) 协议（file/app/data）→ 完全不识别为外链", () => {
    const src = [
        "![](file:///a.png)",
        "![](app://vault/b.png)",
        "![](data:image/png;base64,AAA=)",
    ].join("\n");
    const edits = new PicSource({}, {}).collectReferences(
        src, undefined, wholeParagraphSections(src),
    );
    assert.deepEqual(edits, []);
});

test("collectReferences: 本地 + 外链混排 → 按 start 降序合并去重", () => {
    const src = "AAA ![[a.png]] BBB ![](https://ex.com/b.png) CCC";
    const edits = new PicSource({}, {}).collectReferences(
        src,
        makeEmbedCache(src, [["![[a.png]]", "a.png"]]),
        wholeParagraphSections(src),
    );
    assert.equal(edits.length, 2);
    // b.png 起始 offset 更大，应在前面（供 splice 从末尾往前）。
    assert.equal(edits[0].link, "https://ex.com/b.png");
    assert.equal(edits[1].link, "a.png");
});

// ---------------------------------------------------------------------------
// collectReferences —— inTable 标记
// ---------------------------------------------------------------------------
//
// 表格单元格里 `|` 是列分隔符，size 段必须写成 `\|`。这里只验证「谁在表格
// 里」这个判定；实际转义输出在 resize.test.js 覆盖。

/** `table` section 覆盖 tableText，其余 paragraph section 各覆盖一段正文。 */
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

test("collectReferences: table section 内的 embed 被标记 inTable，表格外为 false", () => {
    const table = "| a | b |\n| - | - |\n| x | ![[in.png]] |";
    const tail = "正文 ![[out.png]] 结束";
    const src = `${table}\n\n${tail}`;
    const edits = new PicSource({}, {}).collectReferences(
        src,
        makeEmbedCache(src, [["![[in.png]]", "in.png"], ["![[out.png]]", "out.png"]]),
        sectionsWithTable(src, table, [tail]),
    );
    const byLink = new Map(edits.map((e) => [e.link, e]));
    assert.equal(byLink.get("in.png").inTable, true);
    assert.equal(byLink.get("out.png").inTable, false);
});

test("collectReferences: sections 缺失 → inTable 一律 false，不猜测表格", () => {
    const src = "| x | ![[a.png]] |";
    const edits = new PicSource({}, {}).collectReferences(
        src, makeEmbedCache(src, [["![[a.png]]", "a.png"]]), undefined,
    );
    assert.equal(edits.length, 1);
    assert.equal(edits[0].inTable, false);
});

test("collectReferences: table section 位置非法 → 不当成表格（safe fallback）", () => {
    const src = "| x | ![[a.png]] |";
    const malformed = [
        { type: "table", position: { start: {}, end: { offset: src.length } } },
        { type: "table", position: { start: { offset: 5 }, end: { offset: 5 } } },
    ];
    const edits = new PicSource({}, {}).collectReferences(
        src, makeEmbedCache(src, [["![[a.png]]", "a.png"]]), malformed,
    );
    assert.equal(edits[0].inTable, false);
});

// ---------------------------------------------------------------------------
// collectReferences —— table section 内的外链
// ---------------------------------------------------------------------------
//
// 外链图不进 metadataCache.embeds，只能靠 section 扫描发现，而 table 一度不在
// 白名单里 —— 于是表格里的 `![alt](https://…)` 从来不会被发现（静默不处理）。
// 单元格内容就是普通 inline Markdown，且不可能出现围栏代码块，反引号 span 又
// 由既有的 masking 处理，所以扫描是安全的。

test("collectReferences: table section 内的 https 外链会被扫到并标记 inTable", () => {
    const table = "| a | b |\n| - | - |\n| x | ![alt](https://ex.com/in.png) |";
    const edits = new PicSource({}, {}).collectReferences(
        table, undefined, sectionsWithTable(table, table),
    );
    assert.equal(edits.length, 1);
    assert.equal(edits[0].kind, "standard");
    assert.equal(edits[0].external, true);
    assert.equal(edits[0].link, "https://ex.com/in.png");
    assert.equal(edits[0].alt, "alt");
    assert.equal(edits[0].inTable, true);
});

test("collectReferences: 同一行多个单元格各自的外链都被扫到", () => {
    const table = "| a | b |\n| - | - |\n| ![](https://ex.com/1.png) | ![](https://ex.com/2.png) |";
    const edits = new PicSource({}, {}).collectReferences(
        table, undefined, sectionsWithTable(table, table),
    );
    // splice 从末尾往前 ⇒ start 更大的 2.png 在前。
    assert.deepEqual(edits.map((e) => e.link), [
        "https://ex.com/2.png",
        "https://ex.com/1.png",
    ]);
    assert.deepEqual(edits.map((e) => e.inTable), [true, true]);
});

test("collectReferences: 表格内已转义的 size 不影响 alt 切分", () => {
    // `\|` 在单元格里是转义竖线；alt 组 [^\]\n]* 照常匹配，altEnd 也要落对。
    const table = "| x | ![alt\\|300](https://ex.com/a.png) |";
    const edits = new PicSource({}, {}).collectReferences(
        table, undefined, sectionsWithTable(table, table),
    );
    assert.equal(edits.length, 1);
    assert.equal(edits[0].alt, "alt\\|300");
    assert.equal(edits[0].link, "https://ex.com/a.png");
});

test("collectReferences: 表格单元格里的反引号 span 仍被屏蔽", () => {
    const table = "| 语法 | 真图 |\n| - | - |\n"
        + "| `![](https://ex.com/x.png)` | ![](https://ex.com/y.png) |";
    const edits = new PicSource({}, {}).collectReferences(
        table, undefined, sectionsWithTable(table, table),
    );
    assert.equal(edits.length, 1);
    assert.equal(edits[0].link, "https://ex.com/y.png");
});

test("collectReferences: callout 与 table section 重叠 → 同一外链只保留一条", () => {
    // callout / blockquote 里嵌表格时，两个 section 可能覆盖同一段文本，
    // 扫描会命中两次；重叠过滤必须把重复项收掉，否则会 splice 两次。
    const table = "| x | ![](https://ex.com/a.png) |";
    const sections = [
        { type: "callout", position: { start: { offset: 0 }, end: { offset: table.length } } },
        { type: "table", position: { start: { offset: 0 }, end: { offset: table.length } } },
    ];
    const edits = new PicSource({}, {}).collectReferences(table, undefined, sections);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].link, "https://ex.com/a.png");
    assert.equal(edits[0].inTable, true);
});

// ---------------------------------------------------------------------------
// resolve —— 本地分支
// ---------------------------------------------------------------------------

test("resolve local: 非图片扩展名 → IGNORE（不计 considered）", async () => {
    const source = makePicSource();
    const edit = { kind: "wikilink", start: 0, end: 12, inner: "note.md", link: "note.md" };
    const res = await source.resolve(edit, "src.md");
    assert.equal(res.kind, RESOLVE_IGNORE);
});

test("resolve local: OCR 不支持的扩展名（svg/gif）→ SKIP", async () => {
    const source = makePicSource();
    const edit = { kind: "wikilink", start: 0, end: 10, inner: "a.svg", link: "a.svg" };
    const res = await source.resolve(edit, "src.md");
    assert.equal(res.kind, RESOLVE_SKIP);
});

test("resolve local: linkpath 无法解析 → SKIP", async () => {
    const plugin = makeFakePlugin({ linkResolver: () => null });
    boot.setImageLoader(() => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));
    const source = new PicSource(plugin.app, { isCancelled: () => false });
    const edit = { kind: "wikilink", start: 0, end: 15, inner: "missing.png", link: "missing.png" };
    const res = await source.resolve(edit, "src.md");
    assert.equal(res.kind, RESOLVE_SKIP);
});

test("resolve local: URL 编码的 link 会被 decodeURIComponent 后送 linkpath 查表", async () => {
    let seenLink = null;
    const plugin = makeFakePlugin({
        linkResolver: (linkpath) => { seenLink = linkpath; return { path: linkpath, __contents: null }; },
    });
    boot.setImageLoader(() => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));
    const source = new PicSource(plugin.app, { isCancelled: () => false });
    const edit = {
        kind: "standard", start: 0, end: 15,
        original: "![](a%20b.png)", alt: "", altEnd: 2,
        link: "a%20b.png",
    };
    const res = await source.resolve(edit, "src.md");
    assert.equal(res.kind, RESOLVE_OK);
    assert.equal(seenLink, "a b.png");
});

test("resolve local: Image 加载失败（naturalWidth=0）→ SKIP", async () => {
    const source = makePicSource();
    boot.setImageLoader(() => ({ ok: false }));
    const edit = { kind: "wikilink", start: 0, end: 10, inner: "a.png", link: "a.png" };
    const res = await source.resolve(edit, "src.md");
    assert.equal(res.kind, RESOLVE_SKIP);
});

test("resolve local: 正常路径 → OK，带 tfile + resourcePath + dims，bytes=null", async () => {
    const source = makePicSource();
    const edit = { kind: "wikilink", start: 0, end: 10, inner: "a.png", link: "a.png" };
    const res = await source.resolve(edit, "src.md");
    assert.equal(res.kind, RESOLVE_OK);
    assert.equal(res.external, false);
    assert.ok(res.tfile);
    assert.equal(res.tfile.path, "a.png");
    assert.equal(res.resourcePath, "app://vault/a.png");
    assert.equal(res.bytes, null);
    assert.deepEqual(res.dims, { naturalWidth: 400, naturalHeight: 200 });
});

// ---------------------------------------------------------------------------
// resolve —— 外链分支
// ---------------------------------------------------------------------------

function makeExternalEdit(url) {
    return {
        kind: "standard",
        external: true,
        start: 0,
        end: 6 + url.length,
        original: `![](${url})`,
        alt: "",
        altEnd: 2,
        link: url,
    };
}

test("resolve external: 200 一次成功 → OK，dims 走 blob URL", async () => {
    const source = makePicSource();
    stubRequestUrlOk();
    const res = await source.resolve(makeExternalEdit("https://ex.com/a.png"), "src.md");
    assert.equal(res.kind, RESOLVE_OK);
    assert.equal(res.external, true);
    assert.equal(res.tfile, null);
    assert.equal(res.resourcePath, null);
    assert.ok(res.bytes instanceof Uint8Array);
    assert.equal(res.bytes.byteLength, 4);
});

test("resolve external: URL 保持原样送入 requestUrl（不做 decodeURIComponent）", async () => {
    const source = makePicSource();
    let seenUrl = null;
    boot.setRequestUrl(async ({ url }) => {
        seenUrl = url;
        return { status: 200, arrayBuffer: new ArrayBuffer(4) };
    });
    await source.resolve(makeExternalEdit("https://ex.com/a%20b.png"), "src.md");
    assert.equal(seenUrl, "https://ex.com/a%20b.png");
});

test("resolve external: 扩展名从 pathname 判断（忽略 query/fragment）", async () => {
    const source = makePicSource();
    stubRequestUrlOk();
    const good = await source.resolve(makeExternalEdit("https://ex.com/a.png?v=2#anchor"), "src.md");
    assert.equal(good.kind, RESOLVE_OK);

    // 反例：pathname 无 .png 扩展 → IGNORE，且不发起请求。
    let requestCalls = 0;
    boot.setRequestUrl(async () => { requestCalls += 1; return { status: 200, arrayBuffer: new ArrayBuffer(4) }; });
    const bad = await source.resolve(makeExternalEdit("https://ex.com/api?type=png"), "src.md");
    assert.equal(bad.kind, RESOLVE_IGNORE);
    assert.equal(requestCalls, 0);
});

test("resolve external: OCR 不支持的格式 → SKIP，不发起下载", async () => {
    const source = makePicSource();
    let requestCalls = 0;
    boot.setRequestUrl(async () => { requestCalls += 1; return { status: 200, arrayBuffer: new ArrayBuffer(4) }; });
    const res = await source.resolve(makeExternalEdit("https://ex.com/anim.gif"), "src.md");
    assert.equal(res.kind, RESOLVE_SKIP);
    assert.equal(requestCalls, 0);
});

test("resolve external: 前两次 500，第三次 200 → OK，恰好 3 次调用", async () => {
    const source = makePicSource();
    let calls = 0;
    boot.setRequestUrl(async () => {
        calls += 1;
        if (calls < 3) return { status: 500, arrayBuffer: new ArrayBuffer(0) };
        return { status: 200, arrayBuffer: new ArrayBuffer(4) };
    });
    const res = await source.resolve(makeExternalEdit("https://ex.com/a.png"), "src.md");
    assert.equal(res.kind, RESOLVE_OK);
    assert.equal(calls, 3);
});

test("resolve external: 三次全 500 → SKIP", async () => {
    const source = makePicSource();
    let calls = 0;
    boot.setRequestUrl(async () => {
        calls += 1;
        return { status: 500, arrayBuffer: new ArrayBuffer(0) };
    });
    const res = await source.resolve(makeExternalEdit("https://ex.com/a.png"), "src.md");
    assert.equal(res.kind, RESOLVE_SKIP);
    assert.equal(calls, 3);
});

test("resolve external: requestUrl 抛错三次 → SKIP，异常不冒泡", async () => {
    const source = makePicSource();
    let calls = 0;
    boot.setRequestUrl(async () => { calls += 1; throw new Error("net down"); });
    const res = await source.resolve(makeExternalEdit("https://ex.com/a.png"), "src.md");
    assert.equal(res.kind, RESOLVE_SKIP);
    assert.equal(calls, 3);
});

test("resolve external: 200 但 body 为空 → 视为失败继续重试", async () => {
    const source = makePicSource();
    let calls = 0;
    boot.setRequestUrl(async () => {
        calls += 1;
        return { status: 200, arrayBuffer: new ArrayBuffer(0) };
    });
    const res = await source.resolve(makeExternalEdit("https://ex.com/a.png"), "src.md");
    assert.equal(res.kind, RESOLVE_SKIP);
    assert.equal(calls, 3);
});

test("resolve external: 下载成功但 blob URL 图像解码失败 → SKIP", async () => {
    const source = makePicSource();
    stubRequestUrlOk();
    boot.setImageLoader((url) => {
        if (String(url).startsWith("blob:")) return { ok: false };
        return { ok: true, naturalWidth: 400, naturalHeight: 200 };
    });
    const res = await source.resolve(makeExternalEdit("https://ex.com/a.png"), "src.md");
    assert.equal(res.kind, RESOLVE_SKIP);
});

test("resolve external: 中途取消（requestUrl 未返回前）→ CANCELLED", async () => {
    let cancelled = false;
    const source = makePicSource({ isCancelled: () => cancelled });
    boot.setRequestUrl(async () => {
        cancelled = true;   // 请求内部翻转 —— 模拟用户在网络往返期间点了取消
        return { status: 200, arrayBuffer: new ArrayBuffer(4) };
    });
    const res = await source.resolve(makeExternalEdit("https://ex.com/a.png"), "src.md");
    assert.equal(res.kind, RESOLVE_CANCELLED);
});

test("resolve external: backoffMs 默认非 0，但仍应能通过 options 覆盖", async () => {
    // 记录：默认构造的 PicSource 在没有 fake timer 的情况下也应该能跑失败重试，
    // 只要测试自己耐得住 <1s 延迟。这里显式设置 backoffMs=0 以保证快速。
    const source = new PicSource(makeFakePlugin().app, {
        isCancelled: () => false,
        backoffMs: 0,
    });
    boot.setImageLoader(() => ({ ok: true, naturalWidth: 400, naturalHeight: 200 }));
    let calls = 0;
    boot.setRequestUrl(async () => {
        calls += 1;
        return { status: 500, arrayBuffer: new ArrayBuffer(0) };
    });
    const res = await source.resolve(makeExternalEdit("https://ex.com/a.png"), "src.md");
    assert.equal(res.kind, RESOLVE_SKIP);
    assert.equal(calls, 3);
});

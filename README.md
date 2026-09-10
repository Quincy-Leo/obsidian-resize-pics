# obsidian-resize-pics

**English** | [简体中文](./README.zh-CN.md)

Pasting an image into a note or clipping one from a web page often leaves the image scaled larger than the surrounding body text — visually jarring, and tedious to fix one by one. This plugin automatically recognizes the font size of the text baked into each image and rewrites the width digit in the image reference syntax `![[..|W]]` / `![alt|W](..)` accordingly.

![compare](./pics/compare.png)

OCR is powered by Tesseract.js; before first use, cache the language models and other assets from the settings page with one click.

- **Minimum Obsidian version**: 1.4.0
- **Platforms**: Desktop only (depends on tesseract.js WASM)
- **UI languages**: Simplified Chinese / English
- **License**: MIT

---

## ✨ Features

- 📏 **Markdown syntax only**: image files are left untouched; the plugin only inserts or updates the width digit inside `![[image.png|W]]` / `![alt|W](image.png)`
- 🔍 **OCR-measured text height**: uses tesseract.js (`eng+chi_sim`, LSTM engine) to recognize the image, then takes the **20% trimmed mean** of line-bbox heights as the pixel height of text baked into the image
- 🎯 **Match the body font size**: `newWidth = round(originalWidth × bodyFontPx / imageTextHeightPx)`, so text inside images looks visually consistent with the body text in the rendered view
- 🛡️ **Atomic writes**: rewrites go through `Vault.process` (read-modify-write); if the note changes during detection, the write is dropped and the user is asked to retry
- 📦 **On-demand deps**: the ~12 MB Tesseract runtime (worker + core WASM + English/Chinese language models) is NOT bundled with the plugin; the user downloads it from the settings page into the plugin folder, with **byte-exact SHA-256 verification**
- 🈯 **Bilingual UI**: switch between Chinese/English in settings; command names and button tooltips refresh in place
- 🧹 **One-click cleanup**: clearing the deps also purges the tesseract.js language-model entries we placed under our IDB namespace (`resize-pics/*` inside `keyval-store`), so no leftovers remain

---

## 🚀 Installation

**Manual install (only supported method for now)**

```
<Your Vault>/.obsidian/plugins/resize-pics/
├── main.js
└── manifest.json
```

1. Create the directory `.obsidian/plugins/resize-pics/` inside your vault
2. Run `npm install` in the repo root
3. Edit `TARGET_DIR` at the top of `build.sh` to point at the directory above, then run `./build.sh` — it bundles via esbuild and copies `main.js` / `manifest.json` for you
4. Enable the plugin in Obsidian, then open its settings page and click **Download dependencies** to pull the ~12 MB Tesseract runtime

---

## 🖱️ Triggering

Open a Markdown document (Reading view / Live Preview / Source mode all work), then choose one of:

- Click the Ribbon icon on the left ![](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWltYWdlLXVwc2NhbGUtaWNvbiBsdWNpZGUtaW1hZ2UtdXBzY2FsZSI+PHBhdGggZD0iTTE2IDNoNXY1Ii8+PHBhdGggZD0iTTE3IDIxaDJhMiAyIDAgMCAwIDItMiIvPjxwYXRoIGQ9Ik0yMSAxMnYzIi8+PHBhdGggZD0ibTIxIDMtNSA1Ii8+PHBhdGggZD0iTTMgN1Y1YTIgMiAwIDAgMSAyLTIiLz48cGF0aCBkPSJtNSAyMSA0LjE0NC00LjE0NGExLjIxIDEuMjEgMCAwIDEgMS43MTIgMEwxMyAxOSIvPjxwYXRoIGQ9Ik05IDNoMyIvPjxyZWN0IHg9IjMiIHk9IjExIiB3aWR0aD0iMTAiIGhlaWdodD0iMTAiIHJ4PSIxIi8+PC9zdmc+)  
- Command palette → `Resize pics to font size` / `将图片缩放到与正文字号一致`

The result is reported via a Notice:

```
resize-pics: resized N image(s) (skipped M).
```

Or, when there are no images to work on:

```
resize-pics: no resizable images found in the current view.
```

---

## ⚙️ Settings

Path: `Settings → Community plugins → resize-pics`

### Language / 语言

| Value | Description |
|---|---|
| `zh-CN` (default) | Chinese UI, command name "将图片缩放到与正文字号一致" |
| `en` | English UI, command name "Resize pics to font size" |

Switching updates the command palette entry and Ribbon tooltip live (internally re-registers via `removeCommand` + `addCommand`).

### OCR dependencies

The settings page shows the status of 4 required assets (`ready / missing`) plus two buttons:

| Button | Behaviour |
|---|---|
| **Download dependencies** | Fetches the 4 files below from the CDN into `<plugin>/tesseract-data/`, verifying each against its pinned SHA-256; interrupted, failed, or hash-mismatched files are retried on the next click |
| **Clear cache** | Deletes the 4 files under `tesseract-data/`, removes that folder if it ends up empty, and evicts every `resize-pics/`-prefixed key from the IndexedDB `keyval-store` |

Dependency manifest (current version):

| File | Source | Notes |
|---|---|---|
| `worker.min.js` | jsDelivr / `tesseract.js@5.1.1` | tesseract.js main-thread scheduler script |
| `tesseract-core-simd.wasm.js` | jsDelivr / `tesseract.js-core@5.1.1` | SIMD core with WASM inlined |
| `eng.traineddata.gz` | `tessdata.projectnaptha.com/4.0.0_fast` | English language model |
| `chi_sim.traineddata.gz` | Same | Simplified Chinese language model |

Versions and hashes are consolidated in the `REQUIRED_ASSETS` array at the top of [src/tesseractDeps.js](src/tesseractDeps.js).

---

## 🏗️ Workflow

```
 ┌──────────────────────────────────────────────────────────────┐
 │  User clicks Ribbon / triggers command                       │
 └────────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  main.js · ResizePicsPlugin.resizePicsToFontSize()            │
 │  · Check: not concurrent / no deps op running / MarkdownView │
 │    has a file                                                │
 └────────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  src/resize.js · ResizeImagesJob.run()                        │
 │  · Read body font size bodyFontPx (getComputedStyle)         │
 │  · vault.read() the current note content                     │
 │  · metadataCache.getFileCache() → embeds + sections          │
 └────────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  src/getPics.js · PicSource                                   │
 │  · collectReferences(embeds, sections):                      │
 │      local (embeds) + external (regex on safe sections)      │
 │      merged, sorted DESC by offset, non-overlapping          │
 │  · resolve(edit) → {kind, tfile|bytes, dims, ...}            │
 │      - local:  getResourcePath + loadImageDimensions         │
 │      - external: requestUrl retry 3× + blob-URL dims         │
 └────────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  ResizeImagesJob.rewriteContent() — resize concerns only     │
 │  · For each edit, dispatch on picSource.resolve().kind       │
 │  · imageTextHeightDetector.ensureWorker() lazily on first use│
 │  · detect({bytes | resourcePath}) → line heights → trimmed   │
 │    mean → imageTextHeightPx                                  │
 │  · newWidth = round(naturalWidth × bodyFontPx / textHeightPx)│
 │  · Rewrite the size segment for both wikilink & standard MD  │
 └────────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  vault.process(file, current => {                             │
 │     if (current !== original) conflict → abort                │
 │     else return newContent                                    │
 │  })                                                           │
 └────────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
                    ✅ Notice: resized N image(s) (skipped M)
```

---

## 🧱 Code layout

```
resize-pics/
├── manifest.json              # Plugin metadata
├── main.js                    # esbuild output; the file Obsidian loads
├── package.json               # Build / check / test scripts
├── build.sh                   # One-shot build + copy to a target vault plugin dir
│
├── src/
│   ├── main.js                # Plugin entry, command/Ribbon registration
│   │                          #   · ResizePicsPlugin (lifecycle + concurrency gate)
│   │
│   ├── settings.js            # Settings store + settings-panel UI
│   │                          #   · LANGUAGE_OPTIONS         (bilingual copy)
│   │                          #   · SETTINGS_SCHEMA_VERSION  (=1; unknown versions refused)
│   │                          #   · ResizePicsSettings       (load/save with snapshot concurrency)
│   │                          #   · ResizePicsSettingTab     (UI + status refresh + download/clear)
│   │                          #   · bilingualError           (used before language is known)
│   │                          #   · localizedError           (used after language is loaded)
│   │
│   ├── getPics.js             # Image discovery + fetching (no OCR / no rewrite)
│   │                          #   · IMAGE_EXT_RE / OCR_SUPPORTED_EXT_RE
│   │                          #   · EXTERNAL_URL_RE / EXTERNAL_HTTPS_RE
│   │                          #   · SAFE_SECTION_TYPES = {paragraph, list, blockquote, callout, table}
│   │                          #   · EXTERNAL_FETCH_MAX_ATTEMPTS=3, BACKOFF_MS=200
│   │                          #   · collectImageReferences         (embeds → edit list)
│   │                          #   · collectExternalImageReferences (sections → edit list)
│   │                          #   · fetchExternalImageBytes        (requestUrl + linear backoff)
│   │                          #   · loadImageDimensions[FromBytes] (URL or blob-URL path)
│   │                          #   · PicSource                       (collectReferences + resolve)
│   │
│   ├── resize.js              # Resize pipeline + Markdown-syntax rewriting
│   │                          #   · CONTENT_ROOT_SELECTORS   (reading/edit-view font source)
│   │                          #   · MAX_SCALE_RATIO=10       (symmetric clamp)
│   │                          #   · rewriteWikilinkInner / rewriteStandardAlt
│   │                          #   · ResizeImagesJob          (run / rewriteContent / dispose)
│   │
│   ├── ocr.js                 # tesseract.js integration
│   │                          #   · CACHE_PATH="resize-pics" (IDB key namespace)
│   │                          #   · MIN_LINE_CONFIDENCE=60, MIN_LINE_HEIGHT_PX=4
│   │                          #   · MIN_LINES_REQUIRED=2, TRIM_FRACTION=0.2
│   │                          #   · ImageTextHeightDetector  (detect({bytes} | {resourcePath}))
│   │                          #   · idbPutAll / evictOcrCache (seed & clear IDB)
│   │
│   └── tesseractDeps.js       # Dependency manifest + download / verify / clear
│                              #   · REQUIRED_ASSETS          (name + url + sha256)
│                              #   · TesseractDependencyManager
│                              #     - checkStatus({verifyHash})
│                              #     - downloadAll(onProgress) (cases A/B/C)
│                              #     - clearCache()             (incl. IDB cleanup)
│
├── ut/
│   ├── main.test.js           # Plugin-level: command registration, Notice copy, concurrency gate
│   ├── getPics.test.js        # Image discovery + fetching: PicSource.collectReferences / resolve
│   ├── resize.test.js         # Editor-level: Markdown-syntax rewrite rules + OCR accounting
│   ├── settings.test.js       # Settings page: status refresh, button state, download/clear callbacks
│   ├── tesseractDeps.test.js  # Deps mgmt: cases A/B/C, cancel, IDB cleanup after seed
│   ├── concurrent.test.js     # Concurrency / lifecycle: async settles across unload
│   └── helpers/               # Test infrastructure
│       ├── bootstrap.js       #   · Fake obsidian module + global DOM/IDB stubs (incl. requestUrl)
│       ├── fakePlugin.js      #   · Substitutable plugin/app/adapter/vault fakes
│       └── loadTesseractDeps.js
│
├── LICENSE                    # MIT
└── README.md / README.zh-CN.md
```

---

## 🔐 Security design

- **End-to-end verified deps**: every Tesseract runtime file has its SHA-256 recomputed and compared against the constants in `REQUIRED_ASSETS` both before being written to disk and on every `checkStatus()` call; a mismatch → the file is removed from disk and reported as failed, and only the user's next "Download" click will retry. Cross-version or supply-chain-poisoned old bytes are never used silently
- **Namespaced IDB entries**: tesseract.js writes traineddata into the shared `keyval-store/keyval` by default; every key this plugin writes carries a `resize-pics/` prefix, and cleanup walks the store with a cursor + `startsWith` filter, so other plugins' entries are never touched
- **Atomic note writes**: uses the `Vault.process(file, updater)` atomic-write API and lets Obsidian's core do conflict detection; when `current !== original`, the write is dropped and the user is notified "do not edit the file during detection, please retry"
- **Table cells never receive a raw pipe**: inside a Markdown table `|` is the column delimiter, so the size segment has to be escaped (`![[img.png\|800]]`) — a bare pipe would split the cell and push the row past the header's column count, breaking both the table and the image reference. Table membership is decided from `cache.sections` (`type: "table"`), never from a "does this line start with `|`?" heuristic, which would miss tables written without outer pipes and misfire on body lines that legitimately begin with one. Segments are split on `/\\?\|/` so a size that is already escaped gets normalised before being written back — without that, a second run would stack backslashes (`a.png\` + `\|`). When `sections` is unavailable nothing is assumed to be a table and the plain-pipe output is kept
- **`cacheMethod: "readOnly"`**: on init failure, tesseract's own recovery tries to `del()` the traineddata IDB key it was pointed at; read-only mode disables that side effect and preserves the bytes we pre-populated
- **Working around the same-origin rule**: Obsidian's main renderer runs at `app://obsidian.md`, and `new Worker("app://<vault-uuid>/…")` is rejected cross-origin. The plugin therefore reads the 4 binaries via `adapter.readBinary` into main-thread memory and wraps the worker + core with `URL.createObjectURL` (blob URLs inherit their creator's origin), bypassing the boundary entirely
- **Unload defenses**: `onunload` synchronously flips `__resizePicsUnloaded` and bumps `_lifecycleGeneration`; every async continuation re-checks both at each `await` point, so a late resolution can never emit a new Notice, mutate a button state, or write a file on disk

---

## ⚠️ Known limitations

- **Desktop only** (`isDesktopOnly: true`): the tesseract.js worker + WASM depends on desktop Electron
- **OCR-supported formats**: `png`, `jpg` / `jpeg`, `webp`, `bmp`. Formats Obsidian recognizes as images but tesseract can't decode (`gif`, `svg`, `avif`, `tiff`) are counted as "considered but skipped"
- **External images are downloaded, verified in `cache.sections`, retried up to 3× per image**: `![alt](https://…/x.png)` doesn't appear in Obsidian's `metadataCache.embeds`, so the plugin scans body-level `cache.sections` (`paragraph`, `list`, `blockquote`, `callout`, `table`) for the syntax, then downloads via `requestUrl` (Obsidian's CORS-immune HTTP client) and runs the same OCR + size-formula path as local images. Non-`http(s)` URIs (`file://`, `app://`, `data:`) are still skipped. `table` is on that list because a cell is ordinary inline Markdown: the constructs that make raw-content scanning unsafe (fenced blocks, frontmatter) cannot appear in one, and inline backtick spans are masked by the same pass used everywhere else. A table nested in a callout can be covered by both sections and therefore matched twice; the overlap filter that merges the local and external edit lists collapses those duplicates
- **Scale clamp**: the `bodyFontPx / imageTextHeightPx` ratio is clamped to `[1/10, 10]`; images outside that range are treated as "extreme text-height outliers" (usually a 1-px noise pixel misrecognized as text) and skipped
- **≥ 2 usable lines required**: a single line is too small a sample and can be pulled around by a misrecognized line; images with fewer usable lines are skipped
- **Minimum line confidence = 60**: any line below this confidence is dropped; dashed borders, JPEG blocking artefacts, and single-pixel dust are frequently seen as 1-px-tall "text" by tesseract
- **Dependency versions are hard-pinned**: the URL + SHA-256 in `REQUIRED_ASSETS` are completely fixed; upgrading tesseract.js requires refreshing both sets of values

---

## 🐛 Common notices / error messages

| Notice / Exception | Explanation / Handling |
|---|---|
| `resize-pics: open a Markdown view first.` | No active Markdown view, or the view has no file bound |
| `resize-pics: no resizable images found in the current view.` | No OCR-capable local images in the view (external links, non-image extensions, cache not built, …) |
| `resize-pics: Do not edit file during detection. Please try again.` | Note content changed while OCR was running; `Vault.process` detected the conflict and dropped the write |
| `resize-pics: OCR dependencies not ready (X/Y missing: …); please download them in Settings.` | Deps missing at OCR time — go to the settings page and click "Download dependencies" |
| `resize-pics: failed to read body font size.` | Neither `.markdown-preview-view` nor `.cm-content` was found in the view container |
| `resize-pics: body font size is invalid.` | Computed `font-size` is not a positive finite number (unusual theme?) |
| `resize-pics: this Obsidian version does not support atomic file updates (Vault.process); please upgrade Obsidian.` | Obsidian too old, missing `Vault.process` |
| `resize-pics: this Obsidian cannot read plugin-folder assets.` | The current adapter has no `readBinary` (mobile / unusual environment) |
| `resize-pics: unsupported settings version X; expected 1.` | Old `data.json` + new plugin; wipe `data.json` or downgrade |
| `resize-pics: dependency download partially failed: X/Y (…).` | See the structured `resize-pics: dependency download failures` log in DevTools |

---

## 🛠️ Development notes

- **Bundled build**: Obsidian only loads the root `main.js` from a plugin folder — other JS files `require`d from it are not synced by Obsidian Sync. Source therefore lives under `src/`, and `npm run build` (esbuild) bundles the whole dependency graph into the root `main.js`
- **One-shot build + distribute**: after editing `TARGET_DIR` at the top of `build.sh`, running it does `npm run build` and copies `main.js` / `manifest.json` into the target vault's plugin directory
- **Tests**: `npm test` uses Node's built-in `node --test`; no external framework
- **package.json scripts**:
  - `npm run build` — esbuild bundle
  - `npm run check` — build + `node --check main.js` (syntax self-check)
  - `npm test` — run `ut/*.test.js`
- **Debug logs**: every `console.log/error` is prefixed with `resize-pics:`; filter for it in Obsidian's DevTools

### Key constants

| Constant | Value | Location |
|---|---|---|
| `PLUGIN_VERSION` | `0.2.0` | `src/main.js` |
| `RESIZE_COMMAND_ID` | `"resize-pics-to-font-size"` | `src/main.js` |
| `RIBBON_ICON_ID` | `"image-upscale"` | `src/main.js` |
| `NOTICE_DURATION_MS` | `4000` | `src/main.js`, `src/settings.js` |
| `SETTINGS_SCHEMA_VERSION` | `1` | `src/settings.js` |
| `MAX_SCALE_RATIO` | `10` | `src/resize.js` |
| `EXTERNAL_FETCH_MAX_ATTEMPTS` | `3` | `src/getPics.js` |
| `EXTERNAL_FETCH_BACKOFF_MS` | `200` | `src/getPics.js` |
| `MIN_LINE_CONFIDENCE` | `60` | `src/ocr.js` |
| `MIN_LINE_HEIGHT_PX` | `4` | `src/ocr.js` |
| `MIN_LINES_REQUIRED` | `2` | `src/ocr.js` |
| `TRIM_FRACTION` | `0.2` | `src/ocr.js` |
| `OCR_LANGS` | `"eng+chi_sim"` | `src/ocr.js` |
| `CACHE_PATH` | `"resize-pics"` | `src/ocr.js` |
| `DATA_SUBDIR` | `"tesseract-data"` | `src/tesseractDeps.js` |
| `TESSERACT_JS_VERSION` | `"5.1.1"` | `src/tesseractDeps.js` |
| `TESSERACT_CORE_VERSION` | `"5.1.1"` | `src/tesseractDeps.js` |

---

## 📄 License

MIT © 2026 [QuincyLeo](https://github.com/Quincy-Leo) (Quincy-Leo)

See [LICENSE](./LICENSE) for details.

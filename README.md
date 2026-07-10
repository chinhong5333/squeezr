# Squeezr

**Compress PNG & JPEG images right in your browser — private, offline, and fast.**

Squeezr shrinks your images using real production-grade codecs (pngquant + oxipng, MozJPEG,
and optional WebP) **entirely on your device**. Nothing is uploaded. No account, no server,
no tracking. Drop images in, click Compress, download a ZIP.

**🔗 Live demo: [squeezr-phi.vercel.app](https://squeezr-phi.vercel.app)**

> ### ⚠️ Beta / Experimental
>
> Squeezr is an **early beta released for experimental use**. It works well for everyday
> graphics, screenshots, and photos, but it has **not** been hardened for
> production-critical or archival pipelines.
>
> - **Keep your originals.** Treat the output as a convenience copy, not a replacement.
> - Compression settings are **fixed** in this release and may change between versions.
> - Behaviour on unusual inputs (huge images, exotic color profiles, animated formats)
>   is not guaranteed. Animated GIF/APNG and non-PNG/JPEG inputs are out of scope.
> - Interfaces, defaults, and output may change without notice while in beta.
>
> Use it, enjoy it, but verify anything important. Feedback and issues are welcome.

---

## Why Squeezr

- **100% private.** Every byte is processed locally via WebAssembly in a Web Worker. Your
  images never leave your device — safe for screenshots, receipts, IDs, or anything sensitive.
- **Works offline.** Installable PWA. After the first visit it runs with no network at all.
- **Real compression, not a re-save.** Uses the same codecs the pros use — pngquant +
  oxipng for PNG, MozJPEG for JPEG, and optional WebP — for typically **60–90% smaller**
  files at visually identical quality.
- **Batch friendly.** Drop, browse, or paste up to 20 images at once; download them
  individually or as a single ZIP.
- **See the difference.** A before/after slider preview lets you check quality before you
  commit.
- **Free.** No ads, no sign-up, no upsell.

---

## Features

- **Formats:** PNG and JPEG in; PNG/JPEG out, or re-encode everything to **WebP** with one
  toggle.
- **Resize (optional):** scale images down by percentage (10%–100%, default 50% when
  enabled) before compressing — aspect ratio preserved, never upscaled. A live badge on each
  card previews the resulting dimensions (`1000×700 → 500×350`).
- **Input any way you like:** drag & drop, click to browse, or paste a screenshot with
  `Ctrl`/`Cmd` + `V`.
- **Before/after preview:** draggable split slider comparing the original and the compressed
  result.
- **Download:** grab a single file, or a timestamped ZIP of the whole batch.
- **Light & dark themes** with a warm coffee palette, plus a subtle cursor-follow background.
- **Safe by default:** if compression can't beat the original, the original is kept
  (unless you explicitly asked for a resize).

---

## How it works

Each image is decoded natively with `OffscreenCanvas` (no decode WASM needed) inside a Web
Worker, then re-encoded with the appropriate codec. Files are processed one at a time to keep
peak memory bounded; codec WebAssembly is loaded lazily on first Compress.

| Step | Codec | Notes |
|---|---|---|
| PNG — quantize | [`imagequant`](https://github.com/ImageOptim/libimagequant) (pngquant algorithm) | Lossy palette reduction, quality floor 65 / target 80 |
| PNG — squeeze | [`@jsquash/oxipng`](https://github.com/jamsinclair/jSquash) | Lossless optimization, level 2 |
| JPEG | [`@jsquash/jpeg`](https://github.com/jamsinclair/jSquash) (MozJPEG) | Quality 80 |
| WebP (optional) | [`@jsquash/webp`](https://github.com/jamsinclair/jSquash) | Quality 80 |

Guards: images above **40 megapixels** are rejected to protect memory; if the PNG quality
floor can't be met, it falls back to a lossless-only pass.

> These quality settings are **hardcoded** in this beta (`src/worker.js`). A settings UI is
> not part of this release.

---

## Getting started

Requires [Node.js](https://nodejs.org/) 18+.

```bash
npm install     # install dependencies
npm run dev     # start the dev server
npm run build   # production build to dist/
npm run preview # preview the production build
```

Then open the printed local URL. The build in `dist/` is a static bundle — host it on any
static server (GitHub Pages, Netlify, Cloudflare Pages, an S3 bucket, `xampp`, …).

---

## Browser support

Needs a modern browser with `OffscreenCanvas`, `createImageBitmap`, WebAssembly, and Web
Workers — recent Chrome, Edge, Firefox, and Safari. Desktop-first; usable on mobile.

---

## Tech stack

- **Build:** [Vite 7](https://vitejs.dev/) (vanilla JS, no framework)
- **Codecs:** `imagequant`, `@jsquash/oxipng`, `@jsquash/jpeg`, `@jsquash/webp` (all WASM)
- **Worker:** single ES-module Web Worker, sequential queue
- **ZIP:** [JSZip](https://stuk.github.io/jszip/)
- **PWA:** [`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/) (Workbox) — precaches the
  app shell and every codec so it works fully offline
- **Font:** self-hosted [Inter](https://rsms.me/inter/) (offline-safe)

---

## Privacy

Squeezr performs **all** processing in your browser. No image data, filename, or metadata is
ever sent to any server — there is no backend. You can confirm this in your browser's network
tab: after the assets load, compressing images makes **zero** network requests.

---

## License

Copyright © 2026 chinhong5333

Licensed under the **GNU General Public License v3.0** — see [`LICENSE`](LICENSE).

Squeezr uses `libimagequant` (GPL) for PNG quantization, so the project as a whole is
effectively GPL-licensed. The other codecs (MozJPEG, oxipng, libwebp via jSquash) are
permissively licensed.

## Credits

Squeezr is built on excellent open-source work:

- **[libimagequant](https://github.com/ImageOptim/libimagequant)** © Kornel Lesiński — PNG
  palette quantization (GPL), used via the
  [`imagequant`](https://www.npmjs.com/package/imagequant) WebAssembly bindings.
- **[jSquash](https://github.com/jamsinclair/jSquash)** © Jamie Sinclair (Apache-2.0) —
  WebAssembly builds of **oxipng**, **MozJPEG**, and **libwebp**.
- **[JSZip](https://stuk.github.io/jszip/)** (MIT) — ZIP archive generation.
- **[Inter](https://rsms.me/inter/)** © Rasmus Andersson (SIL OFL-1.1) — typeface.
- **[Vite](https://vitejs.dev/)** & **[vite-plugin-pwa](https://vite-pwa-org.netlify.app/)** —
  build tooling and offline/PWA support.

All trademarks and copyrights belong to their respective owners.

---

## Disclaimer

Squeezr is a **personal project built for fun, learning, and experimentation** with
in-browser image codecs and WebAssembly. It is intended for **educational, personal, and
experimental use only**. It is **not a commercial product** and is **not intended for
business, professional, or production use**.

- Provided **as-is, with no warranty** of any kind, express or implied. Use at your own risk.
- **No guarantee** of correctness, output quality, availability, security, or fitness for any
  particular purpose.
- The author accepts **no liability** for any data loss or damage — **always keep your
  original files**.
- Not affiliated with, sponsored by, or endorsed by any of the codec projects it builds on
  (pngquant / libimagequant, MozJPEG, oxipng, libwebp, jSquash).

If you need a supported tool for business or production workflows, use a commercial or
actively-maintained service instead.

# Citer — multi-source citation tool

Drag in browser tabs, links, or images and get MLA, APA, or Chicago
(Notes-Bibliography) citations, generated from real page metadata rather
than guesswork — with an optional AI-assisted fallback for the odd field
that can't be found automatically.

## How it's put together

```
citation-tool/
├── index.html            Static frontend — deploy this folder to GitHub Pages
├── css/
├── js/
│   ├── main.js            Wires everything together (start here to read the code)
│   ├── state.js            Source list + localStorage persistence
│   ├── dragdrop.js         Reads real browser DataTransfer data
│   ├── metadataClient.js    Calls the Worker's /api/metadata
│   ├── aiClient.js          Calls the Worker's /api/ai-suggest
│   ├── citations/           MLA / APA / Chicago formatting, style-agnostic
│   ├── render.js            Turns state into DOM markup
│   └── clipboard.js         Rich-text + plaintext bibliography copying
├── assets/fonts/         Put your licensed DIN .woff2 files here
└── worker/
    ├── worker.js           Cloudflare Worker: metadata scraping + AI fallback
    └── wrangler.toml
```

The frontend is plain HTML/CSS/JS with no build step, so it can be served
directly by GitHub Pages. Anything that needs to reach across origins (fetching
a third-party page's metadata) or use a private API key (the AI-assisted
fallback) happens in the small Cloudflare Worker instead — the frontend never
holds a secret.

## 1. Deploy the backend (Cloudflare Worker)

You'll need a free Cloudflare account and `wrangler` (Cloudflare's CLI):

```bash
npm install -g wrangler
cd worker
wrangler login
wrangler deploy
```

This gives you a URL like `https://citation-tool-api.yourname.workers.dev`.

**Optional: enable AI-assisted metadata recovery.** Without this step the app
works fully — it just won't offer "Try AI lookup" for fields it can't find on
its own.

```bash
wrangler secret put ANTHROPIC_API_KEY
```

**Lock it down to your domain.** Once you know what domain your frontend will
live at, edit `worker/wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGIN = "https://yourname.github.io"
```

and redeploy (`wrangler deploy`). Leaving this as `"*"` works but allows any
website to call your Worker.

**Using your existing Cloudflare domain instead of `*.workers.dev`.** In the
Cloudflare dashboard, add a Worker Route (or a custom domain, under
Workers & Pages → your worker → Settings → Domains & Routes) mapping something
like `api.yourdomain.com/*` to this Worker. Either URL works with the frontend
— just use whichever one you put in `js/config.js` (next step).

## 2. Point the frontend at your Worker

Edit `js/config.js`:

```js
export const API_BASE = "https://citation-tool-api.yourname.workers.dev";
// or: "https://api.yourdomain.com"
```

## 3. Add your DIN font files

Drop your licensed DIN `.woff2` files into `assets/fonts/` using the names
listed in that folder's `PUT-FONT-FILES-HERE.txt` (also referenced from
`css/fonts.css`). Missing a weight? Delete or ignore that `@font-face` block —
the app falls back to Arial/Helvetica rather than faking a weight.

## 4. Deploy the frontend to GitHub Pages

Push this whole folder (minus `worker/`, which doesn't need to ship to Pages,
though leaving it there is harmless) to a GitHub repo, then in the repo's
Settings → Pages, set the source to the branch/folder containing `index.html`.

If you're using your existing Cloudflare-managed domain for the *site itself*
(not just the API), set it up as you would any GitHub Pages custom domain:
add a `CNAME` file with your domain, and in Cloudflare DNS add a `CNAME`
record pointing at `yourname.github.io` (with the Cloudflare proxy on or off,
either works — GitHub Pages supports both).

## Testing locally before you deploy

Any static file server works, e.g.:

```bash
npx serve .
```

Drag-and-drop from other browser windows works the same on `localhost` as in
production. Point `js/config.js` at your Worker's `*.workers.dev` URL (or
`http://localhost:8787` if you run `wrangler dev` locally) while testing, and
set `ALLOWED_ORIGIN` to match during that testing too.

## What the drag-and-drop actually detects

Different sources expose different data through the browser's native
`DataTransfer` object, and the app reads whichever is actually present rather
than assuming one shape:

- **Browser tabs / links** → `text/uri-list` (and Firefox's `text/x-moz-url`)
- **An image dragged off a page** → the `<img>` tag inside the dragged
  `text/html` fragment
- **Direct image/CDN links** → same as any link, auto-detected as an image by
  its file extension
- **Image files from your computer** → `DataTransfer.files`, read locally via
  `FileReader` (no page metadata is possible here, so those fields need a
  manual entry or an AI lookup if you also add the source's URL)

When a drop doesn't expose enough to identify the source, the drop zone's
hint text says so briefly, and the manual link field underneath is always
available as a fallback.

## Known simplifications (by design, not oversights)

Citation style rules have effectively unlimited edge cases. This tool covers
the common, high-frequency cases well — single or dual authors, standard
webpage/article/image metadata, missing dates — and leans on the fully
editable per-field panel for anything unusual (corporate authors, translated
works, six-author papers, etc.) rather than trying to silently guess its way
through every case. A few specific calls worth knowing about:

- **APA title italics**: the tool doesn't italicize webpage titles (matching
  APA's own examples for pages that are part of a larger site). If you're
  citing something that should stand alone as its own work, you may want to
  italicize manually after pasting.
- **Author name splitting** assumes "and"/"&" separates multiple authors, and
  otherwise treats a name as a single person — so "Smith, John" (already
  inverted) won't be misread as two people, but also won't automatically
  detect a comma-separated author *list* without "and".
- **AI-assisted fields** are only ever a suggestion: they're never written
  into a citation until you explicitly accept them, and they're always
  labeled as AI-suggested afterward via the field's provenance tag so you can
  find and double-check them later.

## Privacy note for the AI-assisted fallback

If you configure `ANTHROPIC_API_KEY`, the "Try AI lookup" action sends the
source's URL and whatever fields are already known to Anthropic's API
(with web search enabled) to research the one missing field you asked about.
Nothing is sent unless you click that button for that specific field.

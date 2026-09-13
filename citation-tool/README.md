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

- **Author names are a single string, not structured data.** `"Jane Smith and
  John Doe"` splits correctly on "and"/"&"; `"Smith, John, and Jane Doe"`
  (comma-separated list without "and") doesn't. The durable fix is storing
  authors as `[{given, family}]` from the point they're extracted, rather
  than a formatted string every style module re-parses — that's a data-model
  change worth doing before adding more style rules on top of the current
  string-based approach, not a quick patch.
- **APA sentence-case title casing preserves ordinary capitalized words**
  (e.g. "France" in a title stays capitalized) rather than lowercasing them,
  because telling a proper noun apart from an ordinary capitalized word needs
  either a proper-noun dictionary or an NLP pass this tool doesn't have. The
  previous approach — force-lowercase everything but the first word — is
  worse: it also mangles brand names and acronyms embedded in titles (this
  was a real bug: `eBay` became `EBay`, `iPhone` became `IPhone`). Interior-
  capitalized words (`iPhone`, `eBay`, `macOS`) and all-caps acronyms are
  always left untouched in both MLA title case and APA sentence case now.
- **Chicago site/publication names aren't italicized.** CMOS actually treats
  this contextually — a periodical name (*New York Times*) gets italics, a
  plain organization/website name (Google) doesn't — and telling those apart
  reliably needs a curated list of known publications, not a heuristic. The
  tool defaults to roman text, which is correct for the common "generic
  site/blog" case and wrong for "dragged from a major newspaper," which
  you'll need to italicize by hand.
- **AI-assisted fields** are only ever a suggestion: they're never written
  into a citation until you explicitly accept them, and they're always
  labeled as AI-suggested afterward via the field's provenance tag so you can
  find and double-check them later. The AI lookup now uses Claude's tool-use
  for structured output (the model calls a schema-typed `record_citation_field`
  tool rather than free text getting regex-parsed), and the prompt explicitly
  marks the page's own metadata as untrusted data, not instructions.

## Security notes

- **SSRF**: the metadata endpoint fetches arbitrary user-supplied URLs by
  design, so it blocks literal-IP requests to loopback/private/link-local
  addresses and the cloud metadata endpoint, follows redirects manually
  (validating every hop, not just the first URL), and caps response size and
  redirect count. This isn't exhaustive DNS-rebinding protection — it's a
  reasonable floor, not a substitute for treating this as a semi-trusted proxy.
- **CORS fails closed.** `ALLOWED_ORIGIN` is required — an unset value gets
  every request refused rather than silently behaving like `"*"`. It accepts
  a comma-separated list if you need more than one origin live at once.
- **Rate limiting isn't implemented in the Worker itself.** An in-memory
  counter in a Cloudflare Worker is mostly theater — isolates are ephemeral
  and don't reliably share state — so rather than ship something that looks
  like protection but isn't, add a [Cloudflare Rate Limiting
  rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on the
  Worker's route from the dashboard; it needs no code and is actually
  enforced. This matters most for `/api/ai-suggest`, since each call spends
  API credits.
- **Race conditions**: clicking Retry twice, or retrying while an AI lookup
  for the same field is still in flight, used to let a slower, older request
  overwrite a newer one's result. Both now use a per-operation token so only
  the most recently started request for a given source/field is allowed to
  write its result into state.

## Privacy note for the AI-assisted fallback

If you configure `ANTHROPIC_API_KEY`, the "Try AI lookup" action sends the
source's URL and whatever fields are already known to Anthropic's API
(with web search enabled) to research the one missing field you asked about.
Nothing is sent unless you click that button for that specific field.

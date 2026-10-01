# Citer — a bulk research-to-bibliography workspace

Drop or paste a whole batch of sources — links, images, or AI conversations —
and get back a clean, organized MLA, APA, or Chicago (Notes-Bibliography)
bibliography. Citer isn't a one-page-at-a-time citation generator: it's
built around how research actually happens — twenty tabs, some saved
images, a pile of copied URLs — and processes all of it at once, showing
you exactly what it found, what it's unsure about, and what it couldn't
determine on its own.

## How it's put together

```
citer/
├── index.html             Static frontend — deploy this folder to GitHub Pages,
│                           inside a /citation/ subdirectory of an existing site
├── css/
├── js/
│   ├── main.js              Wires everything together (start here to read the code)
│   ├── state.js              Source list + localStorage persistence
│   ├── dragdrop.js           Reads real browser DataTransfer data
│   ├── paste.js               Bulk URL paste — the primary secondary input path
│   ├── db.js                  IndexedDB for local-file image bytes (not localStorage)
│   ├── metadataClient.js      Calls the Worker's /api/metadata
│   ├── aiClient.js            Calls the Worker's /api/ai-suggest
│   ├── citations/             MLA / APA / Chicago formatting, style-agnostic
│   ├── render.js              Turns state into DOM markup
│   └── clipboard.js           Rich-text + plaintext bibliography copying
├── assets/fonts/          Put your licensed DIN .woff2 files here (optional)
└── worker/
    ├── worker.js             Cloudflare Worker: the resolution pipeline + AI research
    ├── resolvers.js           Free, keyless identifier resolvers (DOI/arXiv/PubMed/…)
    ├── authors.js             Shared structured-author parsing
    └── wrangler.toml
```

The frontend is plain HTML/CSS/JS with no build step, so it can be served
directly by GitHub Pages. Anything that needs to reach across origins
(fetching a third-party page's metadata) or use a private API key (the
AI-assisted research fallback) happens in the small Cloudflare Worker
instead — the frontend never holds a secret.

## The source-resolution pipeline

A URL that renders fine in your own browser can still be unreachable to a
server. Two failure modes dominate, and they need different answers:

- **The site refuses datacenter IPs.** Major news sites (NYT among them)
  serve a normal browser fine but return 403 to a Cloudflare Worker.
- **The page is a JavaScript shell.** Olympics.com and most modern SPAs
  return near-empty HTML and render client-side, so there's nothing to
  extract no matter who fetches it.

Neither is solved by a better scraper, and this project deliberately does
**not** spoof user-agents, rotate IPs, or try to defeat bot protection —
that's fragile, hostile, and unnecessary. The answer is more legitimate
doors to the same bibliographic data:

1. **Known identifier → its own authoritative free API.** A DOI resolves
   through Crossref, an arXiv ID through arXiv, a PMID through
   PubMed/NCBI, a Wikipedia URL through Wikimedia's REST API, a YouTube
   link through oEmbed. All keyless and free.
2. **Direct metadata extraction** — JSON-LD, OpenGraph, HTML `<head>`.
   Fastest path, and still the workhorse for ordinary pages.
3. **Citoid** — Wikimedia's free public citation service, which wraps the
   [Zotero translator library](https://github.com/zotero/translators):
   hundreds of community-maintained, per-site extraction rules covering
   exactly the news and institutional sites that block or JS-render. This
   is the same translator infrastructure behind ZoteroBib and much of the
   citation-tool ecosystem, and it's the tier that fixes the NYT/Olympics
   class of failure — Citoid fetches from Wikimedia's infrastructure with
   a proper translator for the site, so it succeeds where a direct fetch
   can't. It also reports whether a real site translator ran or it fell
   back to generic metadata, which the UI passes along.
4. **Internet Archive** — a page that blocks us now was usually crawled
   back when it didn't, and the archived HTML still carries the original
   JSON-LD/OG tags. Uses the free Availability API. The citation always
   points at the **original** URL; the archive is only how the metadata
   was learned, and the snapshot date is never mistaken for a publication
   date.
5. **AI-assisted research, with search** — only when *you* click "Research
   with AI" on one specific missing field. Never automatic.

Tiers 3 and 4 only run when the tier before them came up short, so a
well-behaved page still resolves in one round trip, and Citoid (a free
community service) is used politely rather than on every request.

Every `/api/metadata` response carries `resolution: { method, status, note }`,
so the UI can say something concrete — "Resolved through Wikimedia's Citoid
service using a site-specific Zotero translator," "Recovered from the
Internet Archive's snapshot of 2024-01-16 — check the publication date in
particular," "The site declined automated access" — instead of a generic
error. Crucially, **a source-access failure is not a citation failure**:
even when every tier comes up short, the app returns what it does know
(URL, inferred site name) so you're editing a partial citation rather than
starting from nothing.

### What Citer can't do that MyBib can

MyBib's browser extension notes that it "may, from time to time, utilize
unused bandwidth to crowdsource the collection of citation data," anonymously,
while your browser is idle — i.e. it routes fetches through real users'
browsers on residential IPs. That's why it reaches some sites a server-side
tool can't. Citer is a website, not an extension, and has no equivalent, by
design. The tiers above close most of that gap through legitimate channels
instead.

## AI features — and what they actually cost

Two separate things use AI, and it's worth being clear about the difference:

- **"Research with AI"** (frontend) — resolves one missing field (an
  author, a date) for an ordinary webpage or image. Opt-in per field,
  never automatic.
- **AI as a source type** — citing a ChatGPT/Claude/Gemini/Copilot
  conversation. This never calls an AI API itself; it's citing AI output,
  not using AI to research something.

Only the first one costs anything, and only when you click it.

**If you want $0, genuinely:** set `AI_PROVIDER = "gemini"` and use a
Google AI Studio key. Gemini's Flash-Lite tier has free input and output
tokens, rate-limited in a way that's irrelevant at a demo's traffic level.
The tradeoff, stated plainly the same way the paragraph below states
Anthropic's: Google's free-tier terms permit using submitted content to
improve their products; the paid tier and Anthropic's API don't. For a
tool sending page URLs and short snippets, that's a real but mild thing to
weigh for yourself.

**If you'd rather use Claude:** the default provider is Anthropic, using
Claude Haiku 4.5 — deliberately the cheapest current model, since this is
a short, bounded lookup, not open-ended reasoning. At published rates
($1/$5 per million tokens, plus $10 per 1,000 searches for the web-search
tool this feature uses), one click costs roughly $0.01–0.02 all in. For a
demo where people click that occasionally, that's cents to a couple of
dollars a month, not a cost worth worrying about.

Hosting itself costs nothing either way — Cloudflare Workers' free tier
covers 100,000 requests/day, far more than a demo needs.

If you set neither `ANTHROPIC_API_KEY` nor `GEMINI_API_KEY`, that feature
just stays off. Everything else — bulk paste, drag-and-drop, all five
identifier resolvers, direct scraping, citation formatting and export —
needs no AI and no key at all.

## Updating an existing install

If you already have Citer deployed, you do **not** need to redo any setup.
Unzip the new version somewhere, then from inside it run:

```bash
./scripts/update-citer.sh /path/to/your-portfolio-repo
git -C /path/to/your-portfolio-repo add citation
git -C /path/to/your-portfolio-repo commit -m "Update Citer"
git -C /path/to/your-portfolio-repo push
```

That's the whole update. The script deliberately preserves the files that
are yours rather than mine:

| Preserved | Why |
|---|---|
| `js/config.js` | your Worker URL and AI toggle |
| `assets/fonts/*.woff2` | your licensed font files |
| `CNAME` | your custom domain, if it lives in this folder |

Everything else is replaced wholesale, so files that were renamed or
removed between versions don't linger and quietly get served. Add
`--dry-run` to see what would change first, or `--subdir X` if the app
lives somewhere other than `citation/`.

Your Cloudflare secrets (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY`) live in
Cloudflare, not in this repo, so they survive updates untouched — you
never re-enter them.

### Deploying the Worker on push (optional)

`.github/workflows/deploy-worker.yml` redeploys the Worker automatically
whenever `worker/` changes. It needs two repository secrets —
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — set once under
Settings → Secrets and variables → Actions. The file has the exact steps
in its header comment. `wrangler deploy` leaves your existing Worker
secrets alone, so this never disturbs your API keys.

If you'd rather keep deploying the Worker by hand, `cd worker && wrangler
deploy` still works and you can delete that workflow file.

### One-time setup (first install only)

## 1. Deploy the backend (Cloudflare Worker)

You'll need a free Cloudflare account and `wrangler` (Cloudflare's CLI):

```bash
npm install -g wrangler
cd worker
wrangler login
wrangler deploy
```

This gives you a URL like `https://citer-api.yourname.workers.dev`.

**Optional: enable AI-assisted research.** Without this step the app works
fully — it just won't offer "Research with AI" for fields it can't find on
its own.

```bash
# pick one:
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GEMINI_API_KEY   # and set AI_PROVIDER = "gemini" in wrangler.toml
```

**Lock it down to your domain.** Once you know what domain your frontend
will live at, edit `worker/wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGIN = "https://yourname.github.io"
```

and redeploy (`wrangler deploy`). Leaving this as `"*"` works but allows
any website to call your Worker.

**Using your existing Cloudflare domain instead of `*.workers.dev`.** In
the Cloudflare dashboard, add a Worker Route (or a custom domain, under
Workers & Pages → your worker → Settings → Domains & Routes) mapping
something like `api.yourdomain.com/*` to this Worker. Either URL works
with the frontend — just use whichever one you put in `js/config.js`
(next step).

## 2. Point the frontend at your Worker

Edit the settings block at the top of `js/config.js`:

```js
const PRODUCTION_API = "https://citer-api.yourname.workers.dev";
// or: "https://api.yourdomain.com"
```

You only ever do this once — the update script preserves this file. It
also auto-detects localhost, so `wrangler dev` works without editing the
URL back and forth, and you can temporarily repoint a deployed page with
`localStorage.setItem("citer:api-base", "http://localhost:8787")`.

## 3. Add your DIN font files (optional)

Drop your licensed DIN `.woff2` files into `assets/fonts/` using the names
listed in that folder's `PUT-FONT-FILES-HERE.txt` (also referenced from
`css/fonts.css`). Missing a weight? Delete or ignore that `@font-face`
block — the app falls back to Arial/Helvetica rather than faking a weight.
Citation/bibliography text and headings don't need this step at all — they
use a system-serif stack that needs no download.

## 4. Deploy the frontend to GitHub Pages

This is designed to live inside a `/citation/` subdirectory of an existing
GitHub Pages repository, e.g. `https://yourdomain.com/citation/`. Push this
whole folder (minus `worker/`, which doesn't need to ship to Pages, though
leaving it there is harmless) into that subdirectory, then in the repo's
Settings → Pages, set the source to the branch containing it. All internal
paths are relative, so it doesn't assume it's at the repository root.

If you're using your existing Cloudflare-managed domain for the *site
itself* (not just the API), set it up as you would any GitHub Pages custom
domain: add a `CNAME` file with your domain, and in Cloudflare DNS add a
`CNAME` record pointing at `yourname.github.io` (proxy on or off, either
works).

## Testing locally before you deploy

Any static file server works, e.g.:

```bash
npx serve .
```

Drag-and-drop and bulk paste work the same on `localhost` as in
production. Point `js/config.js` at your Worker's `*.workers.dev` URL (or
`http://localhost:8787` if you run `wrangler dev` locally) while testing,
and set `ALLOWED_ORIGIN` to match during that testing too.

## What bulk paste actually detects

`Ctrl/Cmd+V` anywhere on the page that isn't already a text field is read
for one or more `http(s)` URLs — one per line, several on a line, mixed in
with ordinary prose, bulleted, whatever. Blank lines, surrounding text, and
trailing punctuation don't stop it. Whichever source type is selected
(Webpage / Image / AI) determines how the pasted URLs are treated; pasting
a block of plain text with no URL in it, while AI is selected, is read as
a pasted AI response instead.

## What drag-and-drop actually detects

Different sources expose different data through the browser's native
`DataTransfer` object, and the app reads whichever is actually present
rather than assuming one shape:

- **Links** → `text/uri-list` (and Firefox's `text/x-moz-url`)
- **An image dragged off a page** → the `<img>` tag inside the dragged
  `text/html` fragment
- **Direct image/CDN links** → same as any link, auto-detected as an image
  by its file extension
- **Image files from your computer** → `DataTransfer.files`, kept locally
  in IndexedDB (not localStorage — see below) via `db.js`

An earlier version of this app also tried to support dragging an actual
browser-tab-strip item in. That's not something a webpage can rely on
across browsers without fighting browser security restrictions, so it's
been removed as a distinct feature — a link copied from a tab (or dragged,
where the browser does expose it through the same `DataTransfer` API as
any other link) still works exactly like any other link.

## Known simplifications (by design, not oversights)

- **A bare comma-separated author list is ambiguous and isn't guessed at.**
  "Jane Smith and John Doe" and "Smith, Jane; Doe, John" both split
  correctly. "Smith, Jane, Doe, John" doesn't — a single "Last, First" name
  already uses a comma, so there's no reliable way to tell "one person,
  comma-formatted" from "two people, comma-separated" without guessing
  wrong sometimes. The field's placeholder text says to use `;` for three
  or more authors instead of asking the app to guess.
- **APA sentence-case title casing preserves ordinary capitalized words**
  (e.g. "France" in a title stays capitalized) rather than lowercasing
  them, because telling a proper noun apart from an ordinary capitalized
  word needs either a proper-noun dictionary or an NLP pass this tool
  doesn't have. Interior-capitalized words (`iPhone`, `eBay`, `macOS`) and
  all-caps acronyms are always left untouched in both MLA title case and
  APA sentence case.
- **Corporate authors are detected heuristically.** An author containing
  an organizational word ("Organization", "Institute", "Press", "News"…),
  or four-plus words, or an internal "of/for/the", is printed verbatim
  rather than inverted to "Last, First" — because "World Health
  Organization" is structurally identical to "Jane Quinn Smith". The
  heuristic is good but not perfect; the author field is editable.
- **APA and Chicago site/publication names aren't italicized.** CMOS treats this
  contextually — a periodical name gets italics, a plain organization/
  website name doesn't — and telling those apart reliably needs a curated
  list of known publications, not a heuristic. Both default to roman text,
  which is right for the common "generic site/blog" case and wrong for a
  major newspaper, which you'll want to italicize by hand.
- **AI-source citation formats follow current MLA/APA/Chicago guidance as
  published**, but that guidance is still evolving across all three
  styles — the app says so in the edit panel for AI sources and exposes
  every relevant field for you to check, rather than pretending there's a
  single settled answer.
- **AI-assisted fields are only ever a suggestion**: never written into a
  citation until you explicitly accept them, always labeled afterward via
  the field's provenance tag. The lookup uses tool-use/structured output
  (a schema-typed response) rather than parsing free text, and the prompt
  explicitly marks the page's own metadata as untrusted data, not
  instructions.

## Security notes

- **SSRF**: the metadata endpoint fetches arbitrary user-supplied URLs by
  design, so it blocks literal-IP requests to loopback/private/link-local
  addresses and the cloud metadata endpoint, follows redirects manually
  (validating every hop, not just the first URL), and caps response size
  and redirect count. This isn't exhaustive DNS-rebinding protection —
  it's a reasonable floor, not a substitute for treating this as a
  semi-trusted proxy.
- **CORS fails closed.** `ALLOWED_ORIGIN` is required — an unset value gets
  every request refused rather than silently behaving like `"*"`. It
  accepts a comma-separated list if you need more than one origin live at
  once.
- **Rate limiting isn't implemented in the Worker itself.** An in-memory
  counter in a Cloudflare Worker is mostly theater — isolates are
  ephemeral and don't reliably share state — so rather than ship something
  that looks like protection but isn't, add a [Cloudflare Rate Limiting
  rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on the
  Worker's route from the dashboard; it needs no code and is actually
  enforced. This matters most for `/api/ai-suggest`, since each call spends
  API credits — optional at a demo's traffic level, worth doing before
  wider use.
- **Race conditions**: clicking Retry twice, or retrying while an AI
  lookup for the same field is still in flight, used to let a slower,
  older request overwrite a newer one's result. Both now use a
  per-operation token so only the most recently started request for a
  given source/field is allowed to write its result into state.
- **Local-file images live in IndexedDB, not localStorage.** A dragged or
  pasted image file's actual bytes can easily be several MB; localStorage's
  ~5-10MB total quota (shared with every source's metadata) isn't a safe
  place for that, and would silently fail once you hit the ceiling. Only
  lightweight metadata goes in localStorage; image bytes are looked up by
  source id from IndexedDB and reattached on reload.

## Privacy note for the AI-assisted fallback

If you configure `ANTHROPIC_API_KEY` (or `GEMINI_API_KEY`), the "Research
with AI" action sends the source's URL and whatever fields are already
known to that provider's API (with web search enabled) to research the one
missing field you asked about. Nothing is sent unless you click that
button for that specific field. See "AI features — and what they actually
cost," above, for the tradeoff between the two providers specifically.

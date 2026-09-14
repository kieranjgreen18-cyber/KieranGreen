// Tier 1 of the resolution pipeline: known identifiers resolved through
// their own authoritative, free, keyless APIs — cheaper and more exact than
// scraping the publisher's webpage, and immune to the bot-protection/
// JS-rendering problems that make direct scraping unreliable for exactly
// the kinds of sources that tend to have identifiers (journal articles,
// preprints, encyclopedia entries, videos).
//
// Every resolver here returns either `{ fields, resolutionMethod,
// resolutionNote }` or `null` — never throws. A `null` (no identifier
// matched, or the lookup itself failed/timed out) just means the caller
// falls through to direct-scrape metadata extraction; this tier is a
// shortcut when it applies, not a hard dependency.
//
// None of these need an API key or cost anything, at any volume this app
// is realistically going to see. The polite-use conventions each API asks
// for (an identifying User-Agent for Crossref/NCBI) are followed, but
// there's no billing account or secret to configure.

import { buildAuthors, authorsFromParts, joinAuthorsRaw } from "./authors.js";

const FETCH_TIMEOUT_MS = 8000;
const POLITE_UA = "CiterApp/1.0 (+https://github.com/; citation-research tool)";

async function timedFetch(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function firstNonEmpty(val) {
  if (Array.isArray(val)) return firstNonEmpty(val.find((v) => v && String(v).trim()));
  return val && String(val).trim() ? String(val).trim() : null;
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Looks for a recognizable identifier in a URL. Checked against the raw
 * input URL and, for images, the referring page URL too (an image dragged
 * off an arXiv or Wikipedia page is still worth resolving through its
 * page's identifier even though the image URL itself is just a CDN link).
 */
export function detectIdentifier(url) {
  if (!url) return null;

  // DOI — checked against the raw string first since DOIs show up both as
  // doi.org links and embedded in a publisher's own URL path/query.
  const doiMatch = url.match(/\b10\.\d{4,9}\/[^\s"'<>]+/);
  if (doiMatch) {
    return { type: "doi", id: doiMatch[0].replace(/[.,;)\]]+$/, "") };
  }

  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();

  if (host === "arxiv.org" || host.endsWith(".arxiv.org")) {
    const m = u.pathname.match(/\/(?:abs|pdf)\/([\w.\-/]+?)(?:\.pdf)?\/?$/i);
    if (m) return { type: "arxiv", id: m[1] };
  }

  if (host === "pubmed.ncbi.nlm.nih.gov" || (host === "ncbi.nlm.nih.gov" && /\/pubmed\//i.test(u.pathname))) {
    const m = u.pathname.match(/(\d{6,9})/);
    if (m) return { type: "pubmed", id: m[1] };
  }

  if (host.endsWith(".wikipedia.org")) {
    const m = u.pathname.match(/\/wiki\/([^?#]+)/);
    if (m) return { type: "wikipedia", id: decodeURIComponent(m[1]), lang: host.split(".")[0] };
  }

  if (host === "youtube.com" || host === "www.youtube.com" || host === "youtu.be" || host === "m.youtube.com") {
    // Only actual video pages/short-links carry a citable video, not e.g. a channel or search URL.
    if (host === "youtu.be" || u.pathname === "/watch" || u.pathname.startsWith("/shorts/")) {
      return { type: "youtube", id: url };
    }
  }

  return null;
}

function dateFromCrossrefParts(dateParts) {
  if (!dateParts || !Array.isArray(dateParts) || !dateParts.length) return null;
  const [y, m, d] = dateParts;
  if (!y) return null;
  if (!m) return String(y);
  const mm = String(m).padStart(2, "0");
  const dd = d ? String(d).padStart(2, "0") : "01";
  return `${y}-${mm}-${dd}`;
}

async function resolveDoi(doi) {
  const res = await timedFetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { "User-Agent": POLITE_UA, accept: "application/json" },
  });
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  const m = data && data.message;
  const title = m && firstNonEmpty(m.title);
  if (!m || !title) return null;

  const authors = authorsFromParts(m.author);
  const date =
    dateFromCrossrefParts(m["published-print"] && m["published-print"]["date-parts"] && m["published-print"]["date-parts"][0]) ||
    dateFromCrossrefParts(m["published-online"] && m["published-online"]["date-parts"] && m["published-online"]["date-parts"][0]) ||
    dateFromCrossrefParts(m.created && m.created["date-parts"] && m.created["date-parts"][0]);
  const siteName = firstNonEmpty(m["container-title"]) || m.publisher || null;

  return {
    fields: {
      title,
      authors,
      authorsRaw: joinAuthorsRaw(authors),
      siteName,
      publisher: m.publisher || null,
      datePublished: date,
      dateModified: null,
      description: null,
      url: m.URL || `https://doi.org/${doi}`,
      favicon: null,
    },
    resolutionMethod: "identifier:doi",
    resolutionNote: "Resolved via Crossref (DOI).",
  };
}

async function resolveArxiv(rawId) {
  const id = rawId.replace(/\/$/, "");
  const res = await timedFetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, {
    headers: { accept: "application/atom+xml" },
  });
  if (!res || !res.ok) return null;
  const xml = await res.text();
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) return null;
  const body = entryMatch[1];

  const title = decodeXmlEntities((body.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return null;

  const authorNames = [...body.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => decodeXmlEntities(m[1]).trim());
  const authors = buildAuthors(null, authorNames.join("; "));
  const published = (body.match(/<published>([\s\S]*?)<\/published>/) || [])[1];
  const summary = decodeXmlEntities((body.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "")
    .replace(/\s+/g, " ")
    .trim();
  const idUrl = (body.match(/<id>([\s\S]*?)<\/id>/) || [])[1];

  return {
    fields: {
      title,
      authors,
      authorsRaw: joinAuthorsRaw(authors),
      siteName: "arXiv",
      publisher: "arXiv",
      datePublished: published ? published.slice(0, 10) : null,
      dateModified: null,
      description: summary || null,
      url: idUrl || `https://arxiv.org/abs/${id}`,
      favicon: null,
    },
    resolutionMethod: "identifier:arxiv",
    resolutionNote: "Resolved via the arXiv API.",
  };
}

const PUBMED_MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function normalizePubmedDate(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{4})(?:\s+([A-Za-z]{3}))?(?:\s+(\d{1,2}))?/);
  if (!m) return null;
  const [, y, mon, day] = m;
  if (!mon) return y;
  const mm = String(PUBMED_MONTHS[mon] || 1).padStart(2, "0");
  const dd = day ? String(day).padStart(2, "0") : "01";
  return `${y}-${mm}-${dd}`;
}

/** PubMed's esummary gives authors as "Smith JA" (surname + run-together
 *  initials, no punctuation) rather than a structured given/family pair.
 *  Expands the trailing initials blob into "J. A." for a more readable
 *  edit-field default — sorting/formatting only ever depend on `family`,
 *  which is correct either way. */
function expandPubmedAuthor(author) {
  const literal = author.literal || author.family;
  const m = literal.match(/^(.+?)\s+([A-Z]{1,3})$/);
  if (!m) return author;
  const given = m[2].split("").map((c) => `${c}.`).join(" ");
  return { family: m[1], given, literal: `${given} ${m[1]}` };
}

async function resolvePubmed(pmid) {
  const res = await timedFetch(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`,
    { headers: { "User-Agent": POLITE_UA, accept: "application/json" } }
  );
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  const rec = data && data.result && data.result[pmid];
  const title = rec && firstNonEmpty(rec.title);
  if (!rec || rec.error || !title) return null;

  const authorNames = (rec.authors || []).map((a) => a.name).filter(Boolean);
  const authors = buildAuthors(null, authorNames.join("; ")).map(expandPubmedAuthor);
  const journal = firstNonEmpty(rec.fulljournalname, rec.source);

  return {
    fields: {
      title,
      authors,
      authorsRaw: joinAuthorsRaw(authors),
      siteName: journal,
      publisher: journal,
      datePublished: normalizePubmedDate(rec.pubdate || rec.sortpubdate),
      dateModified: null,
      description: null,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      favicon: null,
    },
    resolutionMethod: "identifier:pubmed",
    resolutionNote: "Resolved via PubMed (NCBI).",
  };
}

async function resolveWikipedia(title, lang) {
  const safeLang = /^[a-z-]{2,12}$/i.test(lang || "") ? lang : "en";
  const summaryRes = await timedFetch(
    `https://${safeLang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    { headers: { accept: "application/json" } }
  );
  if (!summaryRes || !summaryRes.ok) return null;
  const summary = await summaryRes.json().catch(() => null);
  if (!summary || !summary.title || summary.type === "disambiguation") return null;

  const pageUrl =
    (summary.content_urls && summary.content_urls.desktop && summary.content_urls.desktop.page) ||
    `https://${safeLang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;

  // A second, equally free call: the summary endpoint doesn't include a
  // last-revision date, but the standard MediaWiki action API does.
  let date = null;
  const revRes = await timedFetch(
    `https://${safeLang}.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=timestamp&titles=${encodeURIComponent(
      summary.title
    )}&format=json&formatversion=2`,
    { headers: { accept: "application/json" } }
  );
  if (revRes && revRes.ok) {
    const revData = await revRes.json().catch(() => null);
    const page = revData && revData.query && revData.query.pages && revData.query.pages[0];
    const ts = page && page.revisions && page.revisions[0] && page.revisions[0].timestamp;
    if (ts) date = ts.slice(0, 10);
  }

  return {
    fields: {
      title: summary.title,
      authors: [],
      authorsRaw: "",
      siteName: "Wikipedia",
      publisher: "Wikimedia Foundation",
      datePublished: date,
      dateModified: date,
      description: summary.description || null,
      url: pageUrl,
      favicon: null,
    },
    resolutionMethod: "identifier:wikipedia",
    resolutionNote:
      "Resolved via Wikimedia's API. Wikipedia articles don't have a fixed byline, so no individual author is set — citing by title matches standard MLA/APA/Chicago guidance for an encyclopedia entry.",
  };
}

async function resolveYouTube(url) {
  const res = await timedFetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
    headers: { accept: "application/json" },
  });
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.title) return null;

  const authors = data.author_name ? [{ family: data.author_name, given: "", literal: data.author_name }] : [];

  return {
    fields: {
      title: data.title,
      authors,
      authorsRaw: joinAuthorsRaw(authors),
      siteName: "YouTube",
      publisher: "YouTube",
      datePublished: null,
      dateModified: null,
      description: null,
      url,
      favicon: null,
    },
    resolutionMethod: "identifier:youtube",
    resolutionNote: "Resolved via YouTube's oEmbed endpoint. Upload date isn't exposed by oEmbed — add it manually, or use Research with AI.",
  };
}

/**
 * Entry point the Worker calls before falling back to direct scraping.
 * Returns null (never throws) if no identifier was recognized, or if the
 * matching resolver's own fetch failed/timed out/returned nothing usable —
 * either way the caller should proceed to the normal scrape path exactly
 * as if this tier didn't exist.
 */
export async function resolveByIdentifier(url, pageUrl) {
  const ident = detectIdentifier(url) || (pageUrl ? detectIdentifier(pageUrl) : null);
  if (!ident) return null;
  try {
    switch (ident.type) {
      case "doi":
        return await resolveDoi(ident.id);
      case "arxiv":
        return await resolveArxiv(ident.id);
      case "pubmed":
        return await resolvePubmed(ident.id);
      case "wikipedia":
        return await resolveWikipedia(ident.id, ident.lang);
      case "youtube":
        return await resolveYouTube(ident.id);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

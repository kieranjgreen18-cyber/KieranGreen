// Citoid — Wikimedia's public citation service, and the single biggest
// reliability win in this pipeline.
//
// WHY THIS EXISTS
// A Cloudflare Worker fetches from a datacenter IP. Plenty of major sites
// (NYT among them) answer those with a 403 while serving the same page
// fine to a normal browser. Other sites (Olympics.com and most modern SPAs)
// return a near-empty HTML shell and render everything client-side, so
// there's no metadata to extract no matter who asks. Either way, direct
// scraping loses — and the answer is NOT to spoof user-agents or try to
// defeat bot protection, which is both fragile and hostile.
//
// The answer is to ask someone who already solved it. Citoid is a free,
// keyless service run by the Wikimedia Foundation that wraps the Zotero
// translator library — hundreds of community-maintained, per-site
// extraction rules covering exactly the news/reference/institutional sites
// that block or JS-render. It's the same translator infrastructure behind
// ZoteroBib and much of the citation-tool ecosystem. It fetches from
// Wikimedia's own infrastructure, so a site that refuses our datacenter IP
// frequently answers Citoid perfectly well.
//
// COST: nothing. No API key, no account, no quota to buy. Citoid is a
// public good, so this is deliberately polite about it: it runs only AFTER
// direct extraction has already been tried and come up short, sends a real
// identifying User-Agent per Wikimedia's API etiquette, sets a bounded
// timeout, and never retries a failure.
//
// Docs: https://www.mediawiki.org/wiki/Citoid/API
// Endpoint: /api/rest_v1/data/citation/{format}/{uri-encoded url}

import { authorsFromParts, joinAuthorsRaw } from "./authors.js";

const CITOID_BASE = "https://en.wikipedia.org/api/rest_v1/data/citation/mediawiki";
const TIMEOUT_MS = 10000;

// Wikimedia asks API consumers to identify themselves with a descriptive
// User-Agent including a contact URL. Edit this to point at your own repo
// or contact page before running this at any real volume.
const UA = "CiterApp/1.0 (https://github.com/; citation-research tool)";

/**
 * Citoid returns creators as arrays of [firstName, lastName] pairs, e.g.
 * "author": [["Jane", "Smith"], ["John", "Doe"]]. A corporate/institutional
 * author comes through as a single-element pair with an empty first name
 * (["", "Reuters"]) or occasionally just the name in the last position, so
 * both shapes fold into our { family, given, literal } records with the
 * corporate case correctly ending up as family-only (no inverted "Last,
 * First" rendering by the style modules).
 */
function mapCitoidCreators(list) {
  if (!Array.isArray(list)) return [];
  const parts = list
    .map((entry) => {
      if (!Array.isArray(entry)) {
        return typeof entry === "string" && entry.trim() ? { family: entry.trim(), given: "" } : null;
      }
      const given = (entry[0] || "").trim();
      const family = (entry[1] || "").trim();
      if (!family && !given) return null;
      // Citoid puts a one-name/corporate author in either slot depending on
      // the translator; normalize so the name always lands in `family`.
      if (!family) return { family: given, given: "" };
      return { family, given };
    })
    .filter(Boolean);
  return authorsFromParts(parts);
}

/** Citoid dates are usually ISO (YYYY-MM-DD) but translators sometimes emit
 *  "2024-03" or a bare year or a human string. Pass through anything the
 *  citation helpers' own date parser can already cope with, rather than
 *  reformatting here and losing precision. */
function cleanDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  return s || null;
}

/**
 * Resolves one URL through Citoid. Returns { fields, resolutionMethod,
 * resolutionNote, itemType } or null — never throws. A null means the
 * caller should carry on down the ladder (Wayback, then user review /
 * optional AI research) exactly as if this tier didn't exist.
 */
export async function resolveViaCitoid(targetUrl, sourceType) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CITOID_BASE}/${encodeURIComponent(targetUrl)}`, {
      headers: { accept: "application/json", "User-Agent": UA, "Api-User-Agent": UA },
      signal: controller.signal,
    });
    // 404 is Citoid's normal "no translator could resolve this", not an
    // outage — treated identically to any other miss.
    if (!res.ok) return null;

    const data = await res.json().catch(() => null);
    const item = Array.isArray(data) ? data[0] : data;
    if (!item || !item.title) return null;

    const authors = mapCitoidCreators(item.author);
    // Some translators file the byline under contributor/editor instead —
    // fall back rather than dropping a real author on the floor.
    const fallbackAuthors = authors.length ? authors : mapCitoidCreators(item.contributor || item.editor);

    // Citoid reports where it actually got the data: 'Zotero' means a real
    // per-site translator ran, 'Crossref'/'PubMed' mean it resolved an
    // identifier, 'citoid' means it fell back to generic embedded metadata.
    // That distinction is worth surfacing honestly rather than flattening.
    const sources = Array.isArray(item.source) ? item.source : [];
    const via = sources.includes("Zotero")
      ? "a site-specific Zotero translator"
      : sources.includes("Crossref")
      ? "Crossref"
      : sources.includes("PubMed")
      ? "PubMed"
      : "embedded page metadata";

    const fields = {
      title: item.title,
      authors: fallbackAuthors,
      authorsRaw: joinAuthorsRaw(fallbackAuthors),
      // publicationTitle = newspaper/journal/site name depending on itemType;
      // websiteTitle is what the webpage translator uses.
      siteName: item.publicationTitle || item.websiteTitle || item.blogTitle || null,
      publisher: item.publisher || null,
      datePublished: cleanDate(item.date),
      // Citoid's accessDate is when Citoid fetched the page, which is not a
      // dateModified and must never be presented as one.
      dateModified: null,
      description: item.abstractNote || null,
      url: item.url || targetUrl,
      favicon: null,
    };

    if (sourceType === "image") {
      fields.imageTitle = fields.title;
      delete fields.title;
      fields.imageUrl = targetUrl;
    }

    return {
      fields,
      itemType: item.itemType || null,
      resolutionMethod: "citoid",
      resolutionNote: `The site didn't serve its metadata to us directly, so this was resolved through Wikimedia's Citoid service using ${via}.`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

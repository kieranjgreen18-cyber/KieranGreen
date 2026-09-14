export function makeId() {
  return `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** Normalizes a URL for duplicate detection: strips protocol, "www.", trailing slash, and common tracking params. */
export function normalizeUrlForDedupe(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const params = new URLSearchParams(u.search);
    [...params.keys()].forEach((key) => {
      if (/^(utm_|fbclid|gclid|ref|source)/i.test(key)) params.delete(key);
    });
    const search = params.toString();
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.replace(/^www\./, "")}${path}${search ? `?${search}` : ""}`.toLowerCase();
  } catch {
    return String(rawUrl || "").trim().toLowerCase();
  }
}

export function domainFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function faviconUrlFor(rawUrl) {
  const domain = domainFromUrl(rawUrl);
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

export function looksLikeImageUrl(rawUrl) {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp|tiff?)(\?|#|$)/i.test(rawUrl);
}

export function isValidHttpUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? `${str.slice(0, max - 1)}\u2026` : str;
}

/**
 * Pulls every http(s) URL out of an arbitrary block of pasted text — one
 * URL per line, several on one line, bullets, numbering, surrounding prose,
 * blank lines, whatever. This is deliberately forgiving: bulk paste should
 * work with whatever a person actually copied out of their notes, not just
 * a perfectly formatted URL list.
 *
 * Trailing punctuation that's almost certainly not part of the URL (a
 * closing paren with no matching open, a sentence-ending period/comma) is
 * trimmed off, since that's exceedingly common when a URL sits at the end
 * of a sentence or is wrapped in parens.
 */
export function extractUrlsFromText(text) {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"'\u201c\u201d]+/gi) || [];
  const cleaned = matches
    .map((raw) => {
      let url = raw;
      // Strip common trailing punctuation that's part of the sentence, not the URL.
      url = url.replace(/[.,;:!?]+$/, "");
      // A trailing ")" with no matching "(" earlier in the URL is almost
      // always the sentence's parenthesis, not the URL's.
      if (url.endsWith(")") && !url.includes("(")) url = url.slice(0, -1);
      return url;
    })
    .filter(isValidHttpUrl);
  // De-duplicate while preserving first-seen order.
  return [...new Set(cleaned)];
}

/** True if pasted text looks like a bulk list of links rather than prose or
 *  a single sentence someone meant to type into a normal text field. Used to
 *  decide whether a paste anywhere on the page should be intercepted. */
export function looksLikeBulkUrlPaste(text) {
  const urls = extractUrlsFromText(text);
  if (urls.length >= 2) return true;
  if (urls.length === 1) {
    // A single URL that IS essentially the whole pasted string (plus maybe
    // whitespace) is a normal single-link paste — let it go wherever the
    // person pasted it rather than hijacking it.
    return text.trim().length > urls[0].length + 8;
  }
  return false;
}

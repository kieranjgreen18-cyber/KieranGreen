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

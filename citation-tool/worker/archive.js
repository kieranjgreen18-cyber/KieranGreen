// Wayback Machine fallback — the last non-AI net in the resolution ladder.
//
// WHY THIS WORKS
// A live page that refuses our datacenter IP (403) or renders client-side
// was very often crawled and archived by the Internet Archive back when it
// was reachable and server-rendered. That archived copy is plain static
// HTML served by archive.org, which doesn't block us — and it typically
// still carries the original page's JSON-LD, OpenGraph and <meta> tags
// verbatim. So a NYT article we can't fetch directly frequently has a
// perfectly citable snapshot sitting in the archive.
//
// This uses the official, free, keyless Availability JSON API:
//   http://archive.org/wayback/available?url=<url>
// which answers with archived_snapshots.closest = { available, url,
// timestamp, status }, or an empty archived_snapshots object when nothing
// is archived.
//
// IMPORTANT CAVEAT, handled below: the citation must still point at the
// ORIGINAL url, not the web.archive.org one. The archive is how we learned
// the metadata, not the source being cited. The snapshot date is also not
// the publication date and is never treated as one.

const AVAILABILITY_API = "https://archive.org/wayback/available";
const TIMEOUT_MS = 9000;

async function timedFetch(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Turns a Wayback timestamp (YYYYMMDDhhmmss) into a readable date, used
 *  only for the explanatory note — never as citation metadata. */
function formatSnapshotDate(timestamp) {
  const m = String(timestamp || "").match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Finds the closest archived snapshot of a URL.
 * Returns { snapshotUrl, snapshotDate } or null — never throws.
 *
 * The returned snapshotUrl has Wayback's "id_" raw-content modifier applied
 * so archive.org serves the original HTML untouched, without injecting its
 * own toolbar markup and rewriting asset links — which matters, because the
 * injected version can confuse metadata extraction.
 */
export async function findArchivedSnapshot(targetUrl) {
  const res = await timedFetch(`${AVAILABILITY_API}?url=${encodeURIComponent(targetUrl)}`, {
    headers: { accept: "application/json" },
  });
  if (!res || !res.ok) return null;

  const data = await res.json().catch(() => null);
  const closest = data && data.archived_snapshots && data.archived_snapshots.closest;
  if (!closest || !closest.available || !closest.url) return null;
  // Only a snapshot that was itself a successful capture is worth parsing;
  // an archived 404/500 page has no metadata worth having.
  if (closest.status && String(closest.status) !== "200") return null;

  const snapshotUrl = closest.url
    .replace(/^http:\/\//, "https://")
    .replace(/\/web\/(\d{14})\//, "/web/$1id_/");

  return { snapshotUrl, snapshotDate: formatSnapshotDate(closest.timestamp) };
}

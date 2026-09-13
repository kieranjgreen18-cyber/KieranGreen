import * as mla from "./mla.js";
import * as apa from "./apa.js";
import * as chicago from "./chicago.js";

const STYLES = { mla, apa, chicago };

export const STYLE_LABELS = {
  mla: "MLA",
  apa: "APA",
  chicago: "Chicago (N-B)",
};

/**
 * Converts a source's type + fields into a style-agnostic shape so the
 * individual style modules don't need to know whether they're citing a
 * webpage or an image. This is the only place "author vs. creator" and
 * "url vs. imageUrl" get reconciled.
 */
function unify(source) {
  const f = source.fields || {};
  if (source.type === "image") {
    return {
      isImage: true,
      authorName: f.creator || null,
      authorLastName: null, // worker doesn't derive this for creators; style modules fall back to parsing authorName
      title: f.imageTitle || f.title || null,
      siteName: f.siteName || null,
      publisher: f.publisher || null,
      date: f.datePublished || null,
      dateAccessed: f.dateAccessed || null,
      url: f.imageUrl || f.url || null,
    };
  }
  return {
    isImage: false,
    authorName: f.author || null,
    authorLastName: f.authorLastName || null, // extracted server-side when available — more reliable than re-parsing the formatted name
    title: f.title || null,
    siteName: f.siteName || null,
    publisher: f.publisher || null,
    date: f.datePublished || null,
    dateAccessed: f.dateAccessed || null,
    url: f.url || null,
  };
}

/** Returns { html, plaintext, sortKey, isIncomplete } for the given style. */
export function generateCitation(source, style) {
  const mod = STYLES[style] || STYLES.mla;
  const unified = unify(source);
  try {
    return mod.format(unified);
  } catch (err) {
    return {
      html: null,
      plaintext: null,
      sortKey: (unified.title || unified.url || "").toLowerCase(),
      isIncomplete: true,
      error: String(err && err.message || err),
    };
  }
}

export function sortSources(sources) {
  return [...sources].sort((a, b) => {
    const ak = (a.citation && a.citation.sortKey) || "";
    const bk = (b.citation && b.citation.sortKey) || "";
    return ak.localeCompare(bk, undefined, { sensitivity: "base" });
  });
}

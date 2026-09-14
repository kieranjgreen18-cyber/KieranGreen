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
 * webpage, an image, or an AI conversation. This is the only place
 * "author vs. creator" and "url vs. imageUrl" get reconciled, and the only
 * place a raw fields object becomes the structured `authors` array the style
 * modules render from.
 */
function unify(source) {
  const f = source.fields || {};

  if (source.type === "ai") {
    return {
      isAI: true,
      isImage: false,
      aiProvider: f.aiProvider || null,
      aiModel: f.aiModel || null,
      aiConversationTitle: f.aiConversationTitle || null,
      aiPrompt: f.aiPrompt || null,
      date: f.datePublished || null,
      url: f.url || null,
      authors: [],
    };
  }

  if (source.type === "image") {
    return {
      isImage: true,
      authors: f.authors || [],
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
    authors: f.authors || [],
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
      sortKey: (unified.title || unified.aiModel || unified.url || "").toLowerCase(),
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

import { makeId } from "./utils.js";
import { parseAuthors } from "./citations/helpers.js";

const STORAGE_KEY = "citer:v2";

const DEFAULT_STATE = {
  style: "mla",
  sources: [], // see shape notes below
};

/**
 * Source shape:
 * {
 *   id, type: 'webpage'|'image'|'ai',
 *   status: 'detecting'|'fetching'|'analyzing'|'generating'|'complete'|'error',
 *   errorMessage,
 *   dedupeKey,
 *   rawInput: { url, pageUrl, fileName, fileDataUrl },
 *   fields: {
 *     // webpage
 *     title, authors: [{given,family,literal}], authorsRaw, siteName, publisher,
 *     datePublished, dateModified, description, url, favicon,
 *     // image (in addition to the above, aimed at the image rather than a page)
 *     imageUrl, imageTitle,
 *     // ai
 *     aiProvider, aiModel, aiConversationTitle, aiPrompt, responseExcerpt,
 *   },
 *   fieldSource: { <fieldName>: 'extracted'|'ai'|'user'|'missing' },
 *   aiSuggestions: { <fieldName>: { value, evidenceUrl, confidence, note, status } },
 *   resolution: { method, status, note } | null,  // how the backend resolved this source
 *   citation: { html, plaintext, sortKey, isIncomplete } | null,
 * }
 */

let state = load();
const listeners = new Set();

function notify() {
  persist();
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  return state;
}

export function setStyle(style) {
  state = { ...state, style };
  notify();
}

export function addSource(partial) {
  const source = {
    id: makeId(),
    type: "webpage",
    status: "detecting",
    errorMessage: null,
    dedupeKey: null,
    rawInput: {},
    fields: {},
    fieldSource: {},
    aiSuggestions: {},
    citation: null,
    resolution: null,
    addedAt: Date.now(),
    ...partial,
  };
  state = { ...state, sources: [source, ...state.sources] };
  notify();
  return source;
}

export function updateSource(id, patch) {
  state = {
    ...state,
    sources: state.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  };
  notify();
}

export function updateSourceFields(id, fieldPatch, provenance) {
  state = {
    ...state,
    sources: state.sources.map((s) => {
      if (s.id !== id) return s;
      const fields = { ...s.fields, ...fieldPatch };
      const fieldSource = { ...s.fieldSource };
      Object.keys(fieldPatch).forEach((k) => {
        fieldSource[k] = provenance;
      });
      return { ...s, fields, fieldSource };
    }),
  };
  notify();
}

export function removeSource(id) {
  state = { ...state, sources: state.sources.filter((s) => s.id !== id) };
  notify();
}

export function clearAll() {
  state = { ...state, sources: [] };
  notify();
}

export function findByDedupeKey(dedupeKey) {
  return state.sources.find((s) => s.dedupeKey === dedupeKey);
}

/**
 * Counts for the review-queue summary strip. "Ready" means a citation
 * rendered and nothing about it is flagged incomplete. "Needs review" is
 * deliberately concrete — complete-but-missing-a-field, or sitting on an
 * unreviewed AI suggestion — rather than a decorative confidence score.
 */
export function summarize(sources) {
  let ready = 0;
  let review = 0;
  let failed = 0;
  let processing = 0;
  for (const s of sources) {
    if (s.status === "error") {
      failed++;
    } else if (s.status !== "complete") {
      processing++;
    } else if ((s.citation && s.citation.isIncomplete) || hasPendingAiSuggestion(s)) {
      review++;
    } else {
      ready++;
    }
  }
  return { ready, review, failed, processing, total: sources.length };
}

function hasPendingAiSuggestion(source) {
  return Object.values(source.aiSuggestions || {}).some((s) => s && s.status === "pending");
}

function persist() {
  try {
    // Only persist underlying metadata, never the transient "processing" UI
    // states — a reload should never look like it's still in flight. Also
    // strips rawInput.file/fileDataUrl: a File object isn't serializable at
    // all, and a base64 image data URL can easily blow localStorage's quota
    // on its own. Local-file image bytes live in IndexedDB (see db.js),
    // keyed by source id, and get reattached after load — this is metadata
    // only.
    const safeSources = state.sources.map((s) => ({
      ...s,
      status: s.status === "complete" || s.status === "error" ? s.status : "error",
      errorMessage:
        s.status === "complete" || s.status === "error"
          ? s.errorMessage
          : "Processing was interrupted. Retry to continue.",
      // liveImageUrl is a blob:/data: URL scoped to this browser session —
      // persisting it would leave a dead reference after reload, since
      // object URLs don't survive a page load. It gets regenerated from
      // IndexedDB (for local files) on the next startup instead.
      rawInput: { ...s.rawInput, file: null, fileDataUrl: null, liveImageUrl: null },
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ style: state.style, sources: safeSources }));
  } catch {
    // Storage can still fail for other reasons (private browsing, quota from
    // a very large source list). Losing persistence isn't fatal — the app
    // keeps working for the rest of the session either way.
  }
}

const VALID_STATUSES = new Set(["detecting", "fetching", "analyzing", "generating", "complete", "error"]);
const VALID_TYPES = new Set(["webpage", "image", "ai"]);

/** Fills in any missing sub-objects on a persisted source with safe defaults
 *  and normalizes anything that doesn't look like it came from this app, so
 *  an old-schema or hand-edited localStorage entry can't crash the renderer,
 *  which otherwise assumes every source has fields/fieldSource/aiSuggestions
 *  objects and a recognized status. Returns null for anything unsalvageable
 *  (no id), which load() then drops. */
function sanitizeSource(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  return {
    id: String(raw.id),
    type: VALID_TYPES.has(raw.type) ? raw.type : "webpage",
    status: VALID_STATUSES.has(raw.status) ? raw.status : "error",
    errorMessage: typeof raw.errorMessage === "string" ? raw.errorMessage : null,
    dedupeKey: typeof raw.dedupeKey === "string" ? raw.dedupeKey : null,
    missingInfoNote: typeof raw.missingInfoNote === "string" ? raw.missingInfoNote : null,
    rawInput: raw.rawInput && typeof raw.rawInput === "object" ? { ...raw.rawInput, file: null } : {},
    fields: raw.fields && typeof raw.fields === "object" ? raw.fields : {},
    fieldSource: raw.fieldSource && typeof raw.fieldSource === "object" ? raw.fieldSource : {},
    aiSuggestions: raw.aiSuggestions && typeof raw.aiSuggestions === "object" ? raw.aiSuggestions : {},
    citation: raw.citation && typeof raw.citation === "object" ? raw.citation : null,
    resolution: raw.resolution && typeof raw.resolution === "object" ? raw.resolution : null,
    addedAt: typeof raw.addedAt === "number" ? raw.addedAt : Date.now(),
  };
}

/** One-time migration from the old (`citation-tool:v1`) schema, where author
 *  was a single string field. Reads the old key if the new one is empty, so
 *  a returning user's session isn't silently dropped by the storage-key bump
 *  that came with switching authors over to structured records. */
function migrateLegacySources(sources) {
  return sources.map((s) => {
    if (s.fields && typeof s.fields.author === "string" && !s.fields.authors) {
      const authors = parseAuthors(s.fields.author);
      const { author, ...restFields } = s.fields;
      return { ...s, fields: { ...restFields, authors, authorsRaw: author } };
    }
    return s;
  });
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("citation-tool:v1");
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    const style = ["mla", "apa", "chicago"].includes(parsed.style) ? parsed.style : DEFAULT_STATE.style;
    let sources = Array.isArray(parsed.sources) ? parsed.sources.map(sanitizeSource).filter(Boolean) : [];
    sources = migrateLegacySources(sources);
    return { style, sources };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

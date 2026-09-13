import { makeId } from "./utils.js";

const STORAGE_KEY = "citation-tool:v1";

const DEFAULT_STATE = {
  style: "mla",
  sources: [], // see shape notes below
};

/**
 * Source shape:
 * {
 *   id, type: 'webpage'|'image',
 *   status: 'detecting'|'fetching'|'analyzing'|'generating'|'complete'|'error',
 *   errorMessage,
 *   dedupeKey,
 *   rawInput: { url, pageUrl, fileName, fileDataUrl },
 *   fields: { title, author, authorLastName, siteName, publisher, datePublished,
 *             dateModified, description, url, favicon, imageUrl, imageTitle, creator },
 *   fieldSource: { <fieldName>: 'extracted'|'ai'|'user'|'missing' },
 *   aiSuggestions: { <fieldName>: { value, evidenceUrl, confidence, note, status } },
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

export function reorderAll(sortedSources) {
  state = { ...state, sources: sortedSources };
  notify();
}

export function clearAll() {
  state = { ...state, sources: [] };
  notify();
}

export function findByDedupeKey(dedupeKey) {
  return state.sources.find((s) => s.dedupeKey === dedupeKey);
}

function persist() {
  try {
    // Only persist underlying metadata, never the transient "processing" UI
    // states — a reload should never look like it's still in flight. Also
    // strips rawInput.file/fileDataUrl: a File object isn't serializable at
    // all, and a base64 image data URL can easily blow a browser's ~5-10MB
    // localStorage quota on its own, which would silently fail (see catch
    // below) and make it look like the whole session didn't save. Local-file
    // thumbnails are a per-session nicety, not something worth losing the
    // rest of the list over.
    const safeSources = state.sources.map((s) => ({
      ...s,
      status: s.status === "complete" || s.status === "error" ? s.status : "error",
      errorMessage:
        s.status === "complete" || s.status === "error"
          ? s.errorMessage
          : "Processing was interrupted. Retry to continue.",
      rawInput: { ...s.rawInput, file: null, fileDataUrl: null },
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ style: state.style, sources: safeSources }));
  } catch {
    // Storage can still fail for other reasons (private browsing, quota from
    // a very large source list). Losing persistence isn't fatal — the app
    // keeps working for the rest of the session either way.
  }
}

const VALID_STATUSES = new Set(["detecting", "fetching", "analyzing", "generating", "complete", "error"]);
const VALID_TYPES = new Set(["webpage", "image"]);

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
    addedAt: typeof raw.addedAt === "number" ? raw.addedAt : Date.now(),
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    const style = ["mla", "apa", "chicago"].includes(parsed.style) ? parsed.style : DEFAULT_STATE.style;
    const sources = Array.isArray(parsed.sources) ? parsed.sources.map(sanitizeSource).filter(Boolean) : [];
    return { style, sources };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

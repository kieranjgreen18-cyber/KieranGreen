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
    // states — a reload should never look like it's still in flight.
    const safeSources = state.sources.map((s) => ({
      ...s,
      status: s.status === "complete" || s.status === "error" ? s.status : "error",
      errorMessage:
        s.status === "complete" || s.status === "error"
          ? s.errorMessage
          : "Processing was interrupted. Retry to continue.",
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ style: state.style, sources: safeSources }));
  } catch {
    // Storage can fail (private browsing, quota). Losing persistence isn't fatal.
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

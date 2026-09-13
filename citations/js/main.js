import * as store from "./state.js";
import { attachDropZone } from "./dragdrop.js";
import { fetchMetadata } from "./metadataClient.js";
import { checkAiAvailability, requestAiSuggestion } from "./aiClient.js";
import { generateCitation } from "./citations/engine.js";
import * as render from "./render.js";
import { copyRichAndPlain, buildBibliographyHtml, buildBibliographyPlaintext } from "./clipboard.js";
import { normalizeUrlForDedupe, isValidHttpUrl, debounce, makeId } from "./utils.js";

/* --------------------------------------------------------------------- *
 *  DOM references
 * --------------------------------------------------------------------- */

const dropzoneEl = document.getElementById("dropzone");
const styleSelectEl = document.getElementById("style-select");
const typeToggleEl = document.getElementById("type-toggle");
const manualFormEl = document.getElementById("manual-form");
const manualUrlEl = document.getElementById("manual-url");
const clearAllEl = document.getElementById("clear-all");
const duplicateBannersEl = document.getElementById("duplicate-banners");
const citationListEl = document.getElementById("citation-list");
const viewToggleEl = document.getElementById("view-toggle");
const bibliographyOutputEl = document.getElementById("bibliography-output");
const copyAllEl = document.getElementById("copy-all");

/* --------------------------------------------------------------------- *
 *  Ephemeral (non-persisted) UI state
 * --------------------------------------------------------------------- */

let manualType = "webpage";
let bibliographyView = "formatted";
let aiAvailable = false;
const expandedIds = new Set();
const duplicatePrompts = [];
let lastFocused = null; // { id, field, selStart, selEnd } — used to survive re-renders while typing

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fieldDebouncers = new Map();
function getFieldDebouncer(key) {
  if (!fieldDebouncers.has(key)) {
    fieldDebouncers.set(
      key,
      debounce((id, field, value) => commitFieldEdit(id, field, value), 400)
    );
  }
  return fieldDebouncers.get(key);
}

/* --------------------------------------------------------------------- *
 *  Rendering
 * --------------------------------------------------------------------- */

function fullRender() {
  const state = store.getState();
  render.renderSegmented(styleSelectEl, state.style, "style");
  render.renderList(state, citationListEl, { aiAvailable, expandedIds });
  render.renderBibliography(state, bibliographyView, bibliographyOutputEl);
  restoreFocus();
}

function restoreFocus() {
  if (!lastFocused) return;
  const el = citationListEl.querySelector(
    `[data-id="${lastFocused.id}"][data-field="${lastFocused.field}"]`
  );
  if (el) {
    el.focus();
    try {
      el.setSelectionRange(lastFocused.selStart, lastFocused.selEnd);
    } catch {
      /* selection range not applicable, ignore */
    }
  }
}

store.subscribe(fullRender);

function renderDuplicateBanners() {
  duplicateBannersEl.innerHTML = duplicatePrompts
    .map(
      (p) => `
    <div class="duplicate-banner" data-prompt-id="${p.promptId}">
      <span class="duplicate-banner__msg">You've already added a source with this link.</span>
      <button class="btn" data-action="dup-add" data-prompt-id="${p.promptId}">Add anyway</button>
      <button class="btn btn--quiet" data-action="dup-skip" data-prompt-id="${p.promptId}">Skip</button>
    </div>`
    )
    .join("");
}

/* --------------------------------------------------------------------- *
 *  Citation pipeline
 * --------------------------------------------------------------------- */

function finalizeCitation(id) {
  const source = store.getState().sources.find((s) => s.id === id);
  if (!source) return;
  const citation = generateCitation(source, store.getState().style);
  store.updateSource(id, { status: "complete", citation, errorMessage: null });
}

function humanizeFetchError(result) {
  switch (result.error) {
    case "invalid_url":
      return "That link doesn't look valid.";
    case "fetch_failed":
      return `Couldn't reach that source.${result.message ? ` (${result.message})` : ""}`;
    case "timeout":
      return "The source took too long to respond.";
    case "unsupported_content_type":
      return "That link isn't a webpage or an image.";
    case "network_error":
      return "Couldn't reach the citation backend — check your connection or the API address in config.js.";
    default:
      return result.message || "Something went wrong processing this source.";
  }
}

async function processSource(id) {
  const source = store.getState().sources.find((s) => s.id === id);
  if (!source) return;

  const isLocalFileOnly = Boolean(source.rawInput && source.rawInput.file) && !source.fields.imageUrl;
  if (isLocalFileOnly) {
    store.updateSource(id, { status: "analyzing", errorMessage: null });
    await tick(150);
    finalizeCitation(id);
    return;
  }

  const url =
    source.type === "image"
      ? source.fields.imageUrl || (source.rawInput && source.rawInput.url)
      : source.fields.url || (source.rawInput && source.rawInput.url);

  if (!url) {
    store.updateSource(id, { status: "error", errorMessage: "No link to fetch — add one manually below." });
    return;
  }

  store.updateSource(id, { status: "fetching", errorMessage: null });
  const result = await fetchMetadata(url, source.type, source.rawInput && source.rawInput.pageUrl);

  if (!result.ok) {
    store.updateSource(id, { status: "error", errorMessage: humanizeFetchError(result) });
    return;
  }

  store.updateSource(id, { status: "analyzing" });
  await tick(150);

  // Never let extracted metadata clobber a value the person already typed in themselves.
  const current = store.getState().sources.find((s) => s.id === id);
  const incoming = { ...result.fields };
  Object.keys(incoming).forEach((key) => {
    if (current.fieldSource[key] === "user") delete incoming[key];
    if (incoming[key] == null || incoming[key] === "") delete incoming[key];
  });
  store.updateSourceFields(id, incoming, "extracted");

  store.updateSource(id, { status: "generating" });
  await tick(120);
  finalizeCitation(id);
}

function regenerateAllCitations() {
  const state = store.getState();
  state.sources.forEach((source) => {
    if (source.status !== "complete") return;
    const citation = generateCitation(source, state.style);
    store.updateSource(source.id, { citation });
  });
}

/* --------------------------------------------------------------------- *
 *  Turning drag/manual candidates into sources
 * --------------------------------------------------------------------- */

function dedupeKeyFor(candidate) {
  if (candidate.file) return `file:${candidate.file.name}:${candidate.file.size}`;
  if (candidate.url) return normalizeUrlForDedupe(candidate.url);
  return null;
}

function createSourceFromCandidate(candidate, dedupeKey) {
  const initialFields = {};
  if (candidate.type === "image") {
    if (candidate.url) initialFields.imageUrl = candidate.url;
    if (candidate.titleHint) initialFields.imageTitle = candidate.titleHint;
  } else {
    if (candidate.url) initialFields.url = candidate.url;
    if (candidate.titleHint) initialFields.title = candidate.titleHint;
  }

  const fieldSource = {};
  Object.keys(initialFields).forEach((k) => (fieldSource[k] = "extracted"));

  const source = store.addSource({
    type: candidate.type,
    dedupeKey,
    rawInput: {
      url: candidate.url,
      pageUrl: candidate.pageUrl,
      file: candidate.file || null,
      fileDataUrl: candidate.fileDataUrl || null,
      titleHint: candidate.titleHint || null,
    },
    fields: initialFields,
    fieldSource,
    missingInfoNote: candidate.missingInfoNote || null,
  });

  processSource(source.id);
}

function handleCandidate(candidate) {
  if (!candidate || candidate.type === "unknown") {
    flashDropzoneMessage(candidate ? candidate.missingInfoNote : "Nothing usable was dropped.");
    return;
  }

  const dedupeKey = dedupeKeyFor(candidate);
  const existing = dedupeKey ? store.findByDedupeKey(dedupeKey) : null;

  if (existing) {
    const promptId = makeId();
    duplicatePrompts.push({ promptId, candidate, dedupeKey });
    renderDuplicateBanners();
    return;
  }

  createSourceFromCandidate(candidate, dedupeKey);
}

let dropzoneMessageTimer = null;
function flashDropzoneMessage(message) {
  if (!message) return;
  const hint = dropzoneEl.querySelector(".dropzone__hint");
  const original = hint.dataset.original || hint.textContent;
  hint.dataset.original = original;
  hint.textContent = message;
  clearTimeout(dropzoneMessageTimer);
  dropzoneMessageTimer = setTimeout(() => {
    hint.textContent = original;
  }, 4200);
}

/* --------------------------------------------------------------------- *
 *  Field editing
 * --------------------------------------------------------------------- */

function commitFieldEdit(id, field, value) {
  store.updateSourceFields(id, { [field]: value }, "user");
  const source = store.getState().sources.find((s) => s.id === id);
  if (source && source.status === "complete") {
    const citation = generateCitation(source, store.getState().style);
    store.updateSource(id, { citation });
  }
}

async function runAiLookup(id, field) {
  const source = store.getState().sources.find((s) => s.id === id);
  if (!source) return;

  store.updateSource(id, { aiSuggestions: { ...source.aiSuggestions, [field]: { status: "loading" } } });

  const url = source.fields.imageUrl || source.fields.url;
  const result = await requestAiSuggestion({
    url,
    sourceType: source.type,
    style: store.getState().style,
    knownFields: source.fields,
    missingField: field,
  });

  const fresh = store.getState().sources.find((s) => s.id === id);
  if (!fresh) return;

  if (result && result.ok && result.found) {
    store.updateSource(id, {
      aiSuggestions: {
        ...fresh.aiSuggestions,
        [field]: {
          status: "pending",
          value: result.value,
          evidenceUrl: result.evidenceUrl,
          confidence: result.confidence,
          note: result.note,
        },
      },
    });
  } else {
    store.updateSource(id, {
      aiSuggestions: {
        ...fresh.aiSuggestions,
        [field]: { status: "not_found", note: (result && result.note) || "No reliable source found." },
      },
    });
  }
}

function acceptAiSuggestion(id, field) {
  const source = store.getState().sources.find((s) => s.id === id);
  const suggestion = source && source.aiSuggestions[field];
  if (!suggestion || !suggestion.value) return;
  store.updateSourceFields(id, { [field]: suggestion.value }, "ai");
  const rest = { ...source.aiSuggestions };
  delete rest[field];
  store.updateSource(id, { aiSuggestions: rest });
  const refreshed = store.getState().sources.find((s) => s.id === id);
  if (refreshed && refreshed.status === "complete") {
    const citation = generateCitation(refreshed, store.getState().style);
    store.updateSource(id, { citation });
  }
}

function rejectAiSuggestion(id, field) {
  const source = store.getState().sources.find((s) => s.id === id);
  if (!source) return;
  const rest = { ...source.aiSuggestions };
  delete rest[field];
  store.updateSource(id, { aiSuggestions: rest });
}

/* --------------------------------------------------------------------- *
 *  Copying
 * --------------------------------------------------------------------- */

async function copySingleCitation(id, triggerEl) {
  const source = store.getState().sources.find((s) => s.id === id);
  if (!source || !source.citation || !source.citation.plaintext) return;
  const html = buildBibliographyHtml([source]);
  const plain = buildBibliographyPlaintext([source]);
  const ok = await copyRichAndPlain(html, plain);
  flashButton(triggerEl, ok ? "Copied" : "Copy failed");
}

async function copyWholeBibliography() {
  const state = store.getState();
  const complete = state.sources.filter((s) => s.status === "complete" && s.citation && s.citation.html);
  if (!complete.length) return;
  const html = buildBibliographyHtml(complete);
  const plain = buildBibliographyPlaintext(complete);
  const ok = await copyRichAndPlain(html, plain);
  flashButton(copyAllEl, ok ? "Copied" : "Copy failed");
}

function flashButton(el, label) {
  if (!el) return;
  const original = el.textContent;
  el.textContent = label;
  setTimeout(() => {
    el.textContent = original;
  }, 1400);
}

/* --------------------------------------------------------------------- *
 *  Event wiring
 * --------------------------------------------------------------------- */

attachDropZone(dropzoneEl, {
  onDrop: (candidates) => candidates.forEach(handleCandidate),
});

styleSelectEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-style]");
  if (!btn) return;
  store.setStyle(btn.dataset.style);
  regenerateAllCitations();
});

typeToggleEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-type]");
  if (!btn) return;
  manualType = btn.dataset.type;
  render.renderSegmented(typeToggleEl, manualType, "type");
});

manualFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = manualUrlEl.value.trim();
  if (!isValidHttpUrl(url)) {
    manualUrlEl.focus();
    return;
  }
  handleCandidate({ type: manualType, url, pageUrl: null, titleHint: null, missingInfoNote: null });
  manualFormEl.reset();
});

clearAllEl.addEventListener("click", () => {
  if (!store.getState().sources.length) return;
  if (!confirm("Clear every source and start over? This can't be undone.")) return;
  store.clearAll();
  expandedIds.clear();
  duplicatePrompts.length = 0;
  renderDuplicateBanners();
});

viewToggleEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (!btn) return;
  bibliographyView = btn.dataset.view;
  render.renderSegmented(viewToggleEl, bibliographyView, "view");
  render.renderBibliography(store.getState(), bibliographyView, bibliographyOutputEl);
});

copyAllEl.addEventListener("click", copyWholeBibliography);

duplicateBannersEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const promptId = btn.dataset.promptId;
  const idx = duplicatePrompts.findIndex((p) => p.promptId === promptId);
  if (idx === -1) return;
  const [prompt] = duplicatePrompts.splice(idx, 1);
  if (btn.dataset.action === "dup-add") {
    createSourceFromCandidate(prompt.candidate, prompt.dedupeKey);
  }
  renderDuplicateBanners();
});

citationListEl.addEventListener("focusin", (e) => {
  const input = e.target.closest(".field-row__input");
  if (!input) return;
  lastFocused = {
    id: input.dataset.id,
    field: input.dataset.field,
    selStart: input.selectionStart,
    selEnd: input.selectionEnd,
  };
});

citationListEl.addEventListener("input", (e) => {
  const input = e.target.closest(".field-row__input");
  if (!input) return;
  lastFocused = {
    id: input.dataset.id,
    field: input.dataset.field,
    selStart: input.selectionStart,
    selEnd: input.selectionEnd,
  };
  getFieldDebouncer(`${input.dataset.id}:${input.dataset.field}`)(input.dataset.id, input.dataset.field, input.value);
});

citationListEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id, field } = btn.dataset;

  if (action !== "toggle-edit") lastFocused = null;

  switch (action) {
    case "toggle-edit":
      expandedIds.has(id) ? expandedIds.delete(id) : expandedIds.add(id);
      fullRender();
      break;
    case "retry":
      processSource(id);
      break;
    case "remove":
      store.removeSource(id);
      expandedIds.delete(id);
      break;
    case "copy":
      copySingleCitation(id, btn);
      break;
    case "ai-lookup":
      runAiLookup(id, field);
      break;
    case "accept-ai":
      acceptAiSuggestion(id, field);
      break;
    case "reject-ai":
      rejectAiSuggestion(id, field);
      break;
  }
});

/* --------------------------------------------------------------------- *
 *  Startup
 * --------------------------------------------------------------------- */

fullRender();

checkAiAvailability().then((available) => {
  aiAvailable = available;
  fullRender();
});

// Anything left over from a previous session that got interrupted mid-flight
// was already normalized to an 'error' status by the store on load, so it
// just shows up as retry-able rather than stuck spinning forever.

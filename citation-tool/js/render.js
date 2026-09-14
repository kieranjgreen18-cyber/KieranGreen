import { STYLE_LABELS } from "./citations/engine.js";
import { formatAuthorsForEditing } from "./citations/helpers.js";
import { faviconUrlFor, domainFromUrl, truncate, isValidHttpUrl } from "./utils.js";
import { buildBibliographyHtml, buildBibliographyPlaintext } from "./clipboard.js";
import { escapeHtml } from "./citations/helpers.js";
import { summarize } from "./state.js";

const STATUS_LABEL = {
  detecting: "Detecting source",
  fetching: "Fetching source",
  analyzing: "Analyzing metadata",
  generating: "Generating citation",
  complete: "Complete",
  error: "Error",
};

const STATUS_PERCENT = {
  detecting: 12,
  fetching: 40,
  analyzing: 68,
  generating: 90,
  complete: 100,
  error: 100,
};

const TYPE_LABEL = { webpage: "Webpage", image: "Image", ai: "AI" };

const WEBPAGE_FIELDS = [
  { key: "authors", label: "Author(s)" },
  { key: "title", label: "Title" },
  { key: "siteName", label: "Website" },
  { key: "publisher", label: "Publisher" },
  { key: "datePublished", label: "Date" },
  { key: "url", label: "URL" },
];

const IMAGE_FIELDS = [
  { key: "authors", label: "Creator" },
  { key: "imageTitle", label: "Title" },
  { key: "siteName", label: "Website" },
  { key: "publisher", label: "Publisher" },
  { key: "datePublished", label: "Date" },
  { key: "imageUrl", label: "Image URL" },
];

const AI_FIELDS = [
  { key: "aiProvider", label: "Provider" },
  { key: "aiModel", label: "Model" },
  { key: "aiConversationTitle", label: "Title" },
  { key: "aiPrompt", label: "Prompt" },
  { key: "datePublished", label: "Date" },
  { key: "url", label: "Shared link" },
];

const AUTHOR_PLACEHOLDER = 'e.g. "Jane Smith" · two authors: "Jane Smith and John Doe" · three or more: "Smith, Jane; Doe, John; Lee, Kim"';

function escapeAttr(str) {
  return String(str == null ? "" : str).replace(/"/g, "&quot;");
}

function fieldsFor(source) {
  if (source.type === "image") return IMAGE_FIELDS;
  if (source.type === "ai") return AI_FIELDS;
  return WEBPAGE_FIELDS;
}

function fieldValue(source, key) {
  if (key === "authors") return source.fields.authorsRaw ?? formatAuthorsForEditing(source.fields.authors);
  return source.fields[key] || "";
}

export function renderSegmented(container, activeValue, dataAttr) {
  container.querySelectorAll(".segmented__opt").forEach((btn) => {
    const isActive = btn.dataset[dataAttr] === activeValue;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });
}

function renderProgress(source) {
  const pct = STATUS_PERCENT[source.status] ?? 0;
  return `
    <div class="cite-card__progress">
      <div class="cite-card__progress-bar">
        <div class="cite-card__progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="cite-card__progress-label">${STATUS_LABEL[source.status] || ""}</div>
    </div>`;
}

function needsReview(source) {
  if (source.status !== "complete") return false;
  if (source.citation && source.citation.isIncomplete) return true;
  return Object.values(source.aiSuggestions || {}).some((s) => s && s.status === "pending");
}

function renderCitationPreview(source) {
  if (!source.citation || !source.citation.html) {
    return `<div class="cite-card__citation cite-card__citation--incomplete">Not enough information to build a citation yet — open &ldquo;Edit&rdquo; below to fill in the gaps.</div>`;
  }
  const incompleteNote = source.citation.isIncomplete
    ? `<div class="cite-card__review-note">Missing a field or two — check &ldquo;Edit&rdquo; to complete it.</div>`
    : "";
  return `<div class="cite-card__citation">${source.citation.html}${incompleteNote}</div>`;
}

function renderError(source) {
  return `
    <div class="cite-card__error">
      <span class="cite-card__error-msg">${escapeHtml(source.errorMessage || "Something went wrong fetching this source.")}</span>
      <button class="btn" data-action="retry" data-id="${source.id}">Retry</button>
    </div>`;
}

/**
 * A one-line, concrete account of how this source was resolved — shown
 * always for the identifier-based resolvers (Crossref/arXiv/PubMed/
 * Wikipedia/YouTube), since that's worth the credit, and shown for direct
 * extraction only when something about it is worth flagging (a JS-rendered
 * shell, a blocked fetch, a sparse result). A source that resolved cleanly
 * via ordinary scraping doesn't get a badge — that's the unremarkable
 * default case and calling it out on every card would just be noise.
 */
function renderResolutionNote(source) {
  const r = source.resolution;
  if (!r || !r.note) return "";
  const isIdentifier = r.method && r.method.startsWith("identifier:");
  const isFlagged = ["partially_resolved", "js_rendered", "blocked", "failed"].includes(r.status);
  if (!isIdentifier && !isFlagged) return "";
  return `<div class="cite-card__resolution${isFlagged ? " cite-card__resolution--flag" : ""}">${escapeHtml(r.note)}</div>`;
}

function providerTagClass(provenance) {
  return `field-row__tag field-row__tag--${provenance || "missing"}`;
}

function providerTagLabel(provenance) {
  switch (provenance) {
    case "extracted": return "Extracted";
    case "ai": return "AI suggested";
    case "user": return "You edited";
    default: return "Missing";
  }
}

function renderFieldRow(source, def, aiAvailable) {
  const value = fieldValue(source, def.key);
  const provenanceKey = def.key;
  const provenance = source.fieldSource[provenanceKey] || (value ? "extracted" : "missing");
  const suggestion = source.aiSuggestions[def.key];
  const hasResearchableUrl = Boolean(source.fields.url || source.fields.imageUrl);
  const offerAiLookup = aiAvailable && hasResearchableUrl && source.type !== "ai";

  let extra = "";
  if (suggestion && suggestion.status === "loading") {
    extra = `<div class="ai-suggestion-note"><span>Searching for a reliable source…</span></div>`;
  } else if (suggestion && suggestion.status === "pending") {
    extra = `
      <div class="ai-suggestion-note">
        <span>AI suggests &ldquo;${escapeHtml(suggestion.value)}&rdquo;${suggestion.confidence ? ` (${escapeHtml(suggestion.confidence)} confidence)` : ""}${
      suggestion.evidenceUrl ? ` — <a href="${escapeAttr(suggestion.evidenceUrl)}" target="_blank" rel="noopener">source</a>` : ""
    }</span>
        <button data-action="accept-ai" data-id="${source.id}" data-field="${def.key}">Accept</button>
        <button data-action="reject-ai" data-id="${source.id}" data-field="${def.key}">Reject</button>
      </div>`;
  } else if (!value && offerAiLookup) {
    extra = `<button class="field-row__ai-action" data-action="ai-lookup" data-id="${source.id}" data-field="${def.key}">Research with AI</button>`;
  } else if (!value && suggestion && suggestion.status === "not_found") {
    extra = `<div class="ai-suggestion-note"><span>AI couldn't confirm this — ${escapeHtml(suggestion.note || "no reliable source found")}.</span></div>`;
  }

  const placeholder = def.key === "authors" ? ` placeholder="${escapeAttr(AUTHOR_PLACEHOLDER)}"` : "";

  return `
    <div class="field-row">
      <label class="field-row__label" for="field-${source.id}-${def.key}">${def.label}</label>
      <input class="field-row__input" id="field-${source.id}-${def.key}" type="text" data-field="${def.key}" data-id="${source.id}" value="${escapeAttr(value)}"${placeholder} />
      <span class="${providerTagClass(provenance)}">${providerTagLabel(provenance)}</span>
      ${extra}
    </div>`;
}

function renderCard(source, { aiAvailable, expanded }) {
  const rawUrl = source.fields.imageUrl || source.fields.url || (source.rawInput && source.rawInput.url) || "";
  const url = isValidHttpUrl(rawUrl) ? rawUrl : "";
  const domain = domainFromUrl(url) || (source.rawInput && source.rawInput.file ? "your computer" : source.type === "ai" ? "manual entry" : "unknown source");
  const title =
    source.fields.imageTitle ||
    source.fields.aiConversationTitle ||
    source.fields.title ||
    (source.rawInput && source.rawInput.titleHint) ||
    (source.type === "ai" ? source.fields.aiModel || "AI conversation" : domain);
  const iconSrc =
    source.type === "image"
      ? (source.rawInput && source.rawInput.liveImageUrl) ||
        url ||
        (source.rawInput.fileDataUrl && source.rawInput.fileDataUrl.startsWith("data:image/") ? source.rawInput.fileDataUrl : "")
      : source.type === "ai"
      ? ""
      : (isValidHttpUrl(source.fields.favicon) && source.fields.favicon) || faviconUrlFor(url) || "";

  const fields = fieldsFor(source);
  const isProcessing = !["complete", "error"].includes(source.status);
  const flaggedReview = needsReview(source);

  return `
  <article class="cite-card" data-status="${source.status}" data-review="${flaggedReview ? "1" : "0"}" data-id="${source.id}">
    <div class="cite-card__rail" data-rail="${source.status === "error" ? "error" : flaggedReview ? "review" : source.status === "complete" ? "ready" : "processing"}"></div>
    <div class="cite-card__body">
      <header class="cite-card__head">
        <span class="cite-card__type-tag">${TYPE_LABEL[source.type] || "Webpage"}</span>
        ${iconSrc ? `<img class="cite-card__icon" src="${escapeAttr(iconSrc)}" alt="" loading="lazy" />` : `<div class="cite-card__icon cite-card__icon--placeholder"></div>`}
        <div class="cite-card__id">
          <div class="cite-card__title" title="${escapeAttr(title)}">${escapeHtml(truncate(title, 70))}</div>
          <div class="cite-card__domain">${escapeHtml(domain)}${flaggedReview ? ` <span class="cite-card__review-chip">Needs review</span>` : ""}</div>
        </div>
        ${url ? `<a class="cite-card__source-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">Open source</a>` : ""}
      </header>

      ${isProcessing ? renderProgress(source) : ""}
      ${source.status === "error" ? renderError(source) : ""}
      ${renderResolutionNote(source)}
      ${source.status === "complete" ? renderCitationPreview(source) : ""}

      <div class="cite-card__fields" ${expanded ? "" : "hidden"}>
        ${source.missingInfoNote ? `<p class="cite-card__field-note">${escapeHtml(source.missingInfoNote)}</p>` : ""}
        ${source.type === "ai" ? `<p class="cite-card__field-note">AI-citation conventions are still evolving across style guides — double-check this against your instructor's or publication's current requirements.</p>` : ""}
        ${
          source.fields.responseExcerpt
            ? `<details class="cite-card__response"><summary>Pasted response</summary><p class="cite-card__response-text">${escapeHtml(truncate(source.fields.responseExcerpt, 600))}</p></details>`
            : ""
        }
        ${fields.map((def) => renderFieldRow(source, def, aiAvailable)).join("")}
      </div>

      <footer class="cite-card__controls">
        <button class="btn" data-action="toggle-edit" data-id="${source.id}">${expanded ? "Done" : "Edit"}</button>
        <button class="btn" data-action="retry" data-id="${source.id}">Retry</button>
        <button class="btn" data-action="copy" data-id="${source.id}" ${source.citation && source.citation.plaintext ? "" : "disabled"}>Copy</button>
        <span class="spacer"></span>
        <button class="btn btn--quiet btn--danger" data-action="remove" data-id="${source.id}">Remove</button>
      </footer>
    </div>
  </article>`;
}

export function renderSummaryBar(state, container) {
  if (!state.sources.length) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const counts = summarize(state.sources);
  const parts = [];
  parts.push(`<span class="summary-bar__count summary-bar__count--ready">${counts.ready} ready</span>`);
  if (counts.review) {
    parts.push(`<button class="summary-bar__count summary-bar__count--review" data-action="jump-review">${counts.review} need${counts.review === 1 ? "s" : ""} review</button>`);
  }
  if (counts.failed) {
    parts.push(`<button class="summary-bar__count summary-bar__count--failed" data-action="jump-failed">${counts.failed} failed</button>`);
  }
  if (counts.processing) {
    parts.push(`<span class="summary-bar__count summary-bar__count--processing">${counts.processing} processing</span>`);
  }
  container.innerHTML = parts.join(`<span class="summary-bar__sep">·</span>`);
}

export function renderList(state, container, { aiAvailable, expandedIds }) {
  if (!state.sources.length) {
    container.innerHTML = `<div class="empty-state">No sources yet. Drop a link or image above, or paste a batch of URLs anywhere on the page.</div>`;
    return;
  }

  const processing = state.sources.filter((s) => !["complete", "error"].includes(s.status));
  const failed = state.sources.filter((s) => s.status === "error");
  const review = state.sources.filter((s) => s.status === "complete" && needsReview(s));
  const ready = [...state.sources.filter((s) => s.status === "complete" && !needsReview(s))].sort((a, b) =>
    (a.citation?.sortKey || "").localeCompare(b.citation?.sortKey || "", undefined, { sensitivity: "base" })
  );

  const sections = [];
  const group = (label, items) => {
    if (!items.length) return;
    sections.push(`<div class="list-section-label">${label}</div>`);
    sections.push(items.map((s) => renderCard(s, { aiAvailable, expanded: expandedIds.has(s.id) })).join(""));
  };

  group("Processing", processing);
  group("Failed — needs attention", failed);
  group("Needs review", review);
  group(`${STYLE_LABELS[state.style]} bibliography (${ready.length})`, ready);

  container.innerHTML = sections.join("");
}

export function renderBibliography(state, view, container) {
  const complete = state.sources.filter((s) => s.status === "complete" && s.citation && s.citation.html);
  const sorted = [...complete].sort((a, b) =>
    (a.citation.sortKey || "").localeCompare(b.citation.sortKey || "", undefined, { sensitivity: "base" })
  );

  if (!sorted.length) {
    container.classList.remove("is-plain");
    container.innerHTML = `<p class="bibliography-panel__empty">Citations collect here as sources finish processing.</p>`;
    return;
  }

  if (view === "plain") {
    container.classList.add("is-plain");
    container.textContent = buildBibliographyPlaintext(sorted);
  } else {
    container.classList.remove("is-plain");
    container.innerHTML = buildBibliographyHtml(sorted);
  }
}

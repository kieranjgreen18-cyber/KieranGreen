import { STYLE_LABELS } from "./citations/engine.js";
import { faviconUrlFor, domainFromUrl, truncate, isValidHttpUrl } from "./utils.js";
import { buildBibliographyHtml, buildBibliographyPlaintext } from "./clipboard.js";
import { escapeHtml } from "./citations/helpers.js";

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

const WEBPAGE_FIELDS = [
  { key: "author", label: "Author" },
  { key: "title", label: "Title" },
  { key: "siteName", label: "Website" },
  { key: "publisher", label: "Publisher" },
  { key: "datePublished", label: "Date" },
  { key: "url", label: "URL" },
];

const IMAGE_FIELDS = [
  { key: "creator", label: "Creator" },
  { key: "imageTitle", label: "Title" },
  { key: "siteName", label: "Website" },
  { key: "publisher", label: "Publisher" },
  { key: "datePublished", label: "Date" },
  { key: "imageUrl", label: "Image URL" },
];

function escapeAttr(str) {
  return String(str == null ? "" : str).replace(/"/g, "&quot;");
}

function fieldsFor(source) {
  return source.type === "image" ? IMAGE_FIELDS : WEBPAGE_FIELDS;
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
        <div class="cite-card__progress-fill" style="width:${pct}%; background:${
    source.status === "error" ? "var(--status-error)" : "var(--index-blue)"
  }"></div>
      </div>
      <div class="cite-card__progress-label">${STATUS_LABEL[source.status] || ""}</div>
    </div>`;
}

function renderCitationPreview(source) {
  if (!source.citation || !source.citation.html) {
    return `<div class="cite-card__citation cite-card__citation--incomplete">Not enough information to build a citation yet — expand “Edit” below to fill in the gaps.</div>`;
  }
  const incompleteNote = source.citation.isIncomplete
    ? `<div class="cite-card__citation--incomplete" style="margin-top:6px;">Missing a field or two — check “Edit” to complete it.</div>`
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
  const value = source.fields[def.key] || "";
  const provenance = source.fieldSource[def.key] || (value ? "extracted" : "missing");
  const suggestion = source.aiSuggestions[def.key];
  const hasResearchableUrl = Boolean(source.fields.url || source.fields.imageUrl);

  let extra = "";
  if (suggestion && suggestion.status === "loading") {
    extra = `<div class="ai-suggestion-note"><span>Searching for a reliable source…</span></div>`;
  } else if (suggestion && suggestion.status === "pending") {
    extra = `
      <div class="ai-suggestion-note">
        <span>AI suggests “${escapeHtml(suggestion.value)}”${suggestion.confidence ? ` (${escapeHtml(suggestion.confidence)} confidence)` : ""}${
      suggestion.evidenceUrl ? ` — <a href="${escapeAttr(suggestion.evidenceUrl)}" target="_blank" rel="noopener">source</a>` : ""
    }</span>
        <button data-action="accept-ai" data-id="${source.id}" data-field="${def.key}">Accept</button>
        <button data-action="reject-ai" data-id="${source.id}" data-field="${def.key}">Reject</button>
      </div>`;
  } else if (!value && aiAvailable && hasResearchableUrl) {
    extra = `<button class="field-row__ai-action" data-action="ai-lookup" data-id="${source.id}" data-field="${def.key}">Try AI lookup</button>`;
  } else if (!value && suggestion && suggestion.status === "not_found") {
    extra = `<div class="ai-suggestion-note"><span>AI couldn't confirm this — ${escapeHtml(suggestion.note || "no reliable source found")}.</span></div>`;
  }

  return `
    <div class="field-row">
      <label class="field-row__label" for="field-${source.id}-${def.key}">${def.label}</label>
      <input class="field-row__input" id="field-${source.id}-${def.key}" type="text" data-field="${def.key}" data-id="${source.id}" value="${escapeAttr(value)}" />
      <span class="${providerTagClass(provenance)}">${providerTagLabel(provenance)}</span>
      ${extra}
    </div>`;
}

function renderCard(source, { aiAvailable, expanded }) {
  const rawUrl = source.fields.imageUrl || source.fields.url || (source.rawInput && source.rawInput.url) || "";
  const url = isValidHttpUrl(rawUrl) ? rawUrl : "";
  const domain = domainFromUrl(url) || (source.rawInput && source.rawInput.file ? "your computer" : "unknown source");
  const title = source.fields.imageTitle || source.fields.title || (source.rawInput && source.rawInput.titleHint) || domain;
  const iconSrc =
    source.type === "image"
      ? url || (source.rawInput.fileDataUrl && source.rawInput.fileDataUrl.startsWith("data:image/") ? source.rawInput.fileDataUrl : "")
      : faviconUrlFor(url) || "";

  const fields = fieldsFor(source);
  const isProcessing = !["complete", "error"].includes(source.status);

  return `
  <article class="cite-card" data-status="${source.status}" data-id="${source.id}">
    <header class="cite-card__head">
      ${iconSrc ? `<img class="cite-card__icon" src="${escapeAttr(iconSrc)}" alt="" loading="lazy" />` : `<div class="cite-card__icon"></div>`}
      <div class="cite-card__id">
        <div class="cite-card__title" title="${escapeAttr(title)}">${escapeHtml(truncate(title, 70))}</div>
        <div class="cite-card__domain">${escapeHtml(domain)}</div>
      </div>
      ${url ? `<a class="cite-card__source-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">Open source</a>` : ""}
    </header>

    ${isProcessing ? renderProgress(source) : ""}
    ${source.status === "error" ? renderError(source) : ""}
    ${source.status === "complete" ? renderCitationPreview(source) : ""}

    <div class="cite-card__fields" ${expanded ? "" : "hidden"}>
      ${source.missingInfoNote ? `<p style="margin:0 0 8px;color:var(--ink-soft);font-size:var(--fs-label);">${escapeHtml(source.missingInfoNote)}</p>` : ""}
      ${fields.map((def) => renderFieldRow(source, def, aiAvailable)).join("")}
    </div>

    <footer class="cite-card__controls">
      <button class="btn" data-action="toggle-edit" data-id="${source.id}">${expanded ? "Done" : "Edit"}</button>
      <button class="btn" data-action="retry" data-id="${source.id}">Retry</button>
      <button class="btn" data-action="copy" data-id="${source.id}" ${source.citation && source.citation.plaintext ? "" : "disabled"}>Copy</button>
      <span class="spacer"></span>
      <button class="btn btn--quiet btn--danger" data-action="remove" data-id="${source.id}">Remove</button>
    </footer>
  </article>`;
}

export function renderList(state, container, { aiAvailable, expandedIds }) {
  const pending = state.sources.filter((s) => s.status !== "complete");
  const complete = [...state.sources.filter((s) => s.status === "complete")].sort((a, b) =>
    (a.citation?.sortKey || "").localeCompare(b.citation?.sortKey || "", undefined, { sensitivity: "base" })
  );

  if (!state.sources.length) {
    container.innerHTML = `<div class="empty-state">No sources yet. Drag something in above, or paste a link.</div>`;
    return;
  }

  const sections = [];
  if (pending.length) {
    sections.push(`<div class="list-section-label">Processing</div>`);
    sections.push(pending.map((s) => renderCard(s, { aiAvailable, expanded: expandedIds.has(s.id) })).join(""));
  }
  if (complete.length) {
    sections.push(`<div class="list-section-label">${STYLE_LABELS[state.style]} bibliography (${complete.length})</div>`);
    sections.push(complete.map((s) => renderCard(s, { aiAvailable, expanded: expandedIds.has(s.id) })).join(""));
  }
  container.innerHTML = sections.join("");
}

export function renderBibliography(state, view, container) {
  const complete = state.sources.filter((s) => s.status === "complete" && s.citation && s.citation.html);
  const sorted = [...complete].sort((a, b) =>
    (a.citation.sortKey || "").localeCompare(b.citation.sortKey || "", undefined, { sensitivity: "base" })
  );

  if (!sorted.length) {
    container.classList.remove("is-plain");
    container.innerHTML = `<p style="color:var(--ink-soft);">Citations will collect here as sources finish processing.</p>`;
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

import {
  formatAuthorListAPA,
  formatDateAPA,
  toSentenceCaseAPA,
  ensureTerminalPeriod,
  escapeHtml,
  stripLeadingArticle,
} from "./helpers.js";

// APA 7 treats an AI tool as a reference-work-like "author": the company as
// author/publisher, the year, the model (with version) tagged as the work
// type in brackets, and the URL. Mirrors APA Style's own published example:
// "OpenAI. (2023). ChatGPT (Mar 14 version) [Large language model]. https://..."
function formatAI(u) {
  const sentences = [];
  if (u.aiProvider) sentences.push(ensureTerminalPeriod(u.aiProvider));
  sentences.push(ensureTerminalPeriod(formatDateAPA(u.date)));
  if (u.aiModel) sentences.push(ensureTerminalPeriod(`${u.aiModel} [Large language model]`));

  let plain = sentences.filter(Boolean).join(" ");
  let html = sentences.filter(Boolean).map(escapeHtml).join(" ");
  if (u.url) {
    plain += (plain ? " " : "") + u.url;
    html += (html ? " " : "") + `<a href="${escapeHtml(u.url)}">${escapeHtml(u.url)}</a>`;
  }

  const sortKey = (u.aiProvider || u.aiModel || "").toLowerCase();
  return {
    html: html || null,
    plaintext: plain || null,
    sortKey,
    isIncomplete: !u.aiProvider || !u.aiModel,
  };
}

export function format(u) {
  if (u.isAI) return formatAI(u);
  const author = u.authors && u.authors.length ? formatAuthorListAPA(u.authors) : null;
  const dateSentence = ensureTerminalPeriod(formatDateAPA(u.date));
  const rawTitle = u.title ? toSentenceCaseAPA(u.title) : null;
  const titleText = rawTitle ? (u.isImage ? `${rawTitle} [Image]` : rawTitle) : null;

  // APA omits the site/publisher name when it's just the author repeated
  // (e.g. an org's own report on its own site) rather than printing it twice.
  const authorLiteral = u.authors && u.authors.length === 1 ? u.authors[0].literal : null;
  const siteIsAuthor =
    authorLiteral && u.siteName && authorLiteral.trim().toLowerCase() === u.siteName.trim().toLowerCase();

  const sentences = [];
  if (author) {
    sentences.push(ensureTerminalPeriod(author));
    sentences.push(dateSentence);
    if (titleText) sentences.push(ensureTerminalPeriod(titleText));
  } else if (titleText) {
    sentences.push(ensureTerminalPeriod(titleText));
    sentences.push(dateSentence);
  } else {
    sentences.push(dateSentence);
  }
  if (u.siteName && !siteIsAuthor) sentences.push(ensureTerminalPeriod(u.siteName));

  let plain = sentences.filter(Boolean).join(" ");
  let html = sentences.filter(Boolean).map(escapeHtml).join(" ");

  if (u.url) {
    plain += (plain ? " " : "") + u.url;
    html += (html ? " " : "") + `<a href="${escapeHtml(u.url)}">${escapeHtml(u.url)}</a>`;
  }

  const sortKey = (
    (u.authors && u.authors[0] && u.authors[0].family) || (
      rawTitle
        ? stripLeadingArticle(rawTitle)
        : u.siteName || u.url || ""
    )
  ).toLowerCase();

  return {
    html: html || null,
    plaintext: plain || null,
    sortKey,
    isIncomplete: !rawTitle || !u.url,
  };
}

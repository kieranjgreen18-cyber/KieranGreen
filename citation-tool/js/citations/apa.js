import {
  formatAuthorListAPA,
  formatDateAPA,
  toSentenceCaseAPA,
  ensureTerminalPeriod,
  escapeHtml,
  stripLeadingArticle,
  lastNameFromFullName,
} from "./helpers.js";

export function format(u) {
  const author = u.authorName ? formatAuthorListAPA(u.authorName) : null;
  const dateSentence = ensureTerminalPeriod(formatDateAPA(u.date));
  const rawTitle = u.title ? toSentenceCaseAPA(u.title) : null;
  const titleText = rawTitle ? (u.isImage ? `${rawTitle} [Image]` : rawTitle) : null;

  // APA omits the site/publisher name when it's just the author repeated
  // (e.g. an org's own report on its own site) rather than printing it twice.
  const siteIsAuthor =
    u.authorName && u.siteName && u.authorName.trim().toLowerCase() === u.siteName.trim().toLowerCase();

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
    u.authorLastName || (u.authorName && lastNameFromFullName(u.authorName)) || (
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

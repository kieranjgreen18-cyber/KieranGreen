import {
  formatAuthorListChicago,
  formatDateChicago,
  toTitleCaseMLA,
  ensureTerminalPeriod,
  escapeHtml,
  stripLeadingArticle,
} from "./helpers.js";

// Bibliography-entry form (not the shorter note form) of Chicago 17th ed.
// notes-and-bibliography style, since the app's job is compiling a bibliography.
// Chicago uses the same headline-style capitalization as MLA for titles.
export function format(u) {
  const author = u.authorName ? formatAuthorListChicago(u.authorName) : null;
  const date = formatDateChicago(u.date);
  const title = u.title ? toTitleCaseMLA(u.title) : null;
  const siteOrPublisher = u.siteName || u.publisher || null;

  const sentences = [];

  if (author) {
    sentences.push({ html: ensureTerminalPeriod(escapeHtml(author)), plain: ensureTerminalPeriod(author) });
  }

  if (title) {
    if (u.isImage) {
      sentences.push({ html: `<em>${escapeHtml(title)}</em>.`, plain: `${title}.` });
    } else {
      sentences.push({ html: `&ldquo;${escapeHtml(title)}.&rdquo;`, plain: `\u201C${title}.\u201D` });
    }
  }

  if (siteOrPublisher) {
    sentences.push({ html: ensureTerminalPeriod(escapeHtml(siteOrPublisher)), plain: ensureTerminalPeriod(siteOrPublisher) });
  }

  if (date) {
    sentences.push({ html: ensureTerminalPeriod(escapeHtml(date)), plain: ensureTerminalPeriod(date) });
  }

  if (u.url) {
    const bare = u.url.replace(/^https?:\/\//, "");
    sentences.push({ html: ensureTerminalPeriod(escapeHtml(bare)), plain: ensureTerminalPeriod(bare) });
  }

  const html = sentences.map((s) => s.html).join(" ").trim();
  const plain = sentences.map((s) => s.plain).join(" ").trim();

  const sortKey = (
    author
      ? author.split(",")[0]
      : title
      ? stripLeadingArticle(title)
      : siteOrPublisher || u.url || ""
  ).toLowerCase();

  return {
    html: html || null,
    plaintext: plain || null,
    sortKey,
    isIncomplete: !title || !u.url,
  };
}

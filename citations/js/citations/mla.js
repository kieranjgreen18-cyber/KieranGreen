import {
  formatAuthorListMLA,
  formatDateMLA,
  toTitleCaseMLA,
  ensureTerminalPeriod,
  escapeHtml,
  stripLeadingArticle,
} from "./helpers.js";

export function format(u) {
  const author = u.authorName ? formatAuthorListMLA(u.authorName) : null;
  const title = u.title ? toTitleCaseMLA(u.title) : null;
  const date = formatDateMLA(u.date);
  const showPublisher =
    u.publisher && (!u.siteName || u.publisher.toLowerCase() !== u.siteName.toLowerCase());

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

  const containerParts = [];
  if (u.siteName) {
    containerParts.push({ html: `<em>${escapeHtml(u.siteName)}</em>`, plain: u.siteName });
  }
  if (showPublisher) {
    containerParts.push({ html: escapeHtml(u.publisher), plain: u.publisher });
  }
  if (date) {
    containerParts.push({ html: escapeHtml(date), plain: date });
  }
  if (u.url) {
    const bare = u.url.replace(/^https?:\/\//, "");
    containerParts.push({ html: escapeHtml(bare), plain: bare });
  }

  if (containerParts.length) {
    const html = containerParts.map((p) => p.html).join(", ") + ".";
    const plain = containerParts.map((p) => p.plain).join(", ") + ".";
    sentences.push({ html, plain });
  }

  const html = sentences.map((s) => s.html).join(" ").trim();
  const plain = sentences.map((s) => s.plain).join(" ").trim();

  const sortKey = (
    author
      ? author.split(",")[0]
      : title
      ? stripLeadingArticle(title)
      : u.siteName || u.url || ""
  ).toLowerCase();

  return {
    html: html || null,
    plaintext: plain || null,
    sortKey,
    isIncomplete: !title || !u.url,
  };
}

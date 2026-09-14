import {
  formatAuthorListMLA,
  formatDateMLA,
  toTitleCaseMLA,
  ensureTerminalPeriod,
  escapeHtml,
  stripLeadingArticle,
} from "./helpers.js";

// MLA 9 style guidance for AI-generated text treats the tool as a "container"
// rather than an author: quote the prompt (or a supplied title) as the title
// element, then the model, the provider as publisher, the date, and the
// shared URL if one exists. See MLA Style Center's "How do I cite generative
// AI" guidance — this mirrors the pattern in their own worked example.
function formatAI(u) {
  const titleText = u.aiConversationTitle || (u.aiPrompt ? `${u.aiPrompt}` : null);
  const sentences = [];

  if (titleText) {
    sentences.push({ html: `&ldquo;${escapeHtml(titleText)}.&rdquo;`, plain: `\u201C${titleText}.\u201D` });
  }

  const containerParts = [];
  if (u.aiModel) containerParts.push({ html: `<em>${escapeHtml(u.aiModel)}</em>`, plain: u.aiModel });
  if (u.aiProvider) containerParts.push({ html: escapeHtml(u.aiProvider), plain: u.aiProvider });
  const date = formatDateMLA(u.date);
  if (date) containerParts.push({ html: escapeHtml(date), plain: date });
  if (u.url) {
    const bare = u.url.replace(/^https?:\/\//, "");
    containerParts.push({ html: escapeHtml(bare), plain: bare });
  }
  if (containerParts.length) {
    sentences.push({
      html: containerParts.map((p) => p.html).join(", ") + ".",
      plain: containerParts.map((p) => p.plain).join(", ") + ".",
    });
  }

  const html = sentences.map((s) => s.html).join(" ").trim();
  const plain = sentences.map((s) => s.plain).join(" ").trim();
  const sortKey = (u.aiModel || u.aiProvider || titleText || "").toLowerCase();

  return {
    html: html || null,
    plaintext: plain || null,
    sortKey,
    isIncomplete: !u.aiModel || !u.aiProvider,
  };
}

export function format(u) {
  if (u.isAI) return formatAI(u);
  const author = u.authors && u.authors.length ? formatAuthorListMLA(u.authors) : null;
  const title = u.title ? toTitleCaseMLA(u.title) : null;
  const date = formatDateMLA(u.date);
  // MLA convention: an access date only earns a place when there's no publish
  // date to cite instead — never both, and never as a substitute for one.
  const accessedDate = !date && u.dateAccessed ? formatDateMLA(u.dateAccessed) : null;
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

  if (accessedDate) {
    sentences.push({
      html: `Accessed ${escapeHtml(accessedDate)}.`,
      plain: `Accessed ${accessedDate}.`,
    });
  }

  const html = sentences.map((s) => s.html).join(" ").trim();
  const plain = sentences.map((s) => s.plain).join(" ").trim();

  const sortKey = (
    (u.authors && u.authors[0] && u.authors[0].family) || (
      title
        ? stripLeadingArticle(title)
        : u.siteName || u.url || ""
    )
  ).toLowerCase();

  return {
    html: html || null,
    plaintext: plain || null,
    sortKey,
    isIncomplete: !title || !u.url,
  };
}

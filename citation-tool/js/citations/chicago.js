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
// CMOS (17th ed.) still primarily treats AI chatbot output as something to
// describe in running text or a note rather than a bibliography entry, but
// its own guidance offers this optional bibliography-style pattern:
// "OpenAI. ChatGPT. Response to "prompt." Month Day, Year. URL."
function formatAI(u) {
  const sentences = [];
  if (u.aiProvider) sentences.push({ html: ensureTerminalPeriod(escapeHtml(u.aiProvider)), plain: ensureTerminalPeriod(u.aiProvider) });
  if (u.aiModel) sentences.push({ html: ensureTerminalPeriod(escapeHtml(u.aiModel)), plain: ensureTerminalPeriod(u.aiModel) });

  const promptLabel = u.aiConversationTitle || u.aiPrompt;
  if (promptLabel) {
    sentences.push({
      html: `Response to &ldquo;${escapeHtml(promptLabel)}.&rdquo;`,
      plain: `Response to \u201C${promptLabel}.\u201D`,
    });
  }

  const date = formatDateChicago(u.date);
  if (date) sentences.push({ html: ensureTerminalPeriod(escapeHtml(date)), plain: ensureTerminalPeriod(date) });

  if (u.url) {
    const bare = u.url.replace(/^https?:\/\//, "");
    sentences.push({ html: ensureTerminalPeriod(escapeHtml(bare)), plain: ensureTerminalPeriod(bare) });
  }

  const html = sentences.map((s) => s.html).join(" ").trim();
  const plain = sentences.map((s) => s.plain).join(" ").trim();
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
  const author = u.authors && u.authors.length ? formatAuthorListChicago(u.authors) : null;
  const date = formatDateChicago(u.date);
  const accessedDate = !date && u.dateAccessed ? formatDateChicago(u.dateAccessed) : null;
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
  } else if (accessedDate) {
    sentences.push({
      html: `Accessed ${escapeHtml(accessedDate)}.`,
      plain: `Accessed ${accessedDate}.`,
    });
  }

  if (u.url) {
    const bare = u.url.replace(/^https?:\/\//, "");
    sentences.push({ html: ensureTerminalPeriod(escapeHtml(bare)), plain: ensureTerminalPeriod(bare) });
  }

  const html = sentences.map((s) => s.html).join(" ").trim();
  const plain = sentences.map((s) => s.plain).join(" ").trim();

  const sortKey = (
    (u.authors && u.authors[0] && u.authors[0].family) || (
      title
        ? stripLeadingArticle(title)
        : siteOrPublisher || u.url || ""
    )
  ).toLowerCase();

  return {
    html: html || null,
    plaintext: plain || null,
    sortKey,
    isIncomplete: !title || !u.url,
  };
}

// Shared helpers for turning raw source fields into style-formatted citation
// pieces. Kept deliberately simple and well-commented: citation style rules
// have endless edge cases (corporate authors, six+ authors, missing dates...).
// These helpers cover the common cases well; the editable-fields panel in the
// UI is the escape hatch for anything unusual.

const MLA_MONTHS = [
  "Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July",
  "Aug.", "Sept.", "Oct.", "Nov.", "Dec.",
];
const FULL_MONTHS = [
  "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December",
];

const MLA_LOWERCASE_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet",
  "as", "at", "by", "in", "into", "of", "off", "on", "onto", "out",
  "over", "per", "to", "up", "via", "with", "from",
]);

/** Best-effort parse of a date string into { year, month, day } (month 1-12). */
export function parseDateParts(input) {
  if (!input) return null;
  const isoMatch = String(input).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return { year: Number(isoMatch[1]), month: Number(isoMatch[2]), day: Number(isoMatch[3]) };
  }
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return { year: parsed.getUTCFullYear(), month: parsed.getUTCMonth() + 1, day: parsed.getUTCDate() };
  }
  const yearOnly = String(input).match(/(\d{4})/);
  if (yearOnly) return { year: Number(yearOnly[1]), month: null, day: null };
  return null;
}

export function formatDateMLA(input) {
  const d = parseDateParts(input);
  if (!d) return null;
  if (d.day && d.month) return `${d.day} ${MLA_MONTHS[d.month - 1]} ${d.year}`;
  if (d.month) return `${MLA_MONTHS[d.month - 1]} ${d.year}`;
  return String(d.year);
}

export function formatDateChicago(input) {
  const d = parseDateParts(input);
  if (!d) return null;
  if (d.day && d.month) return `${FULL_MONTHS[d.month - 1]} ${d.day}, ${d.year}`;
  if (d.month) return `${FULL_MONTHS[d.month - 1]} ${d.year}`;
  return String(d.year);
}

/** Returns just the "(Year, Month Day)" (or subset) parenthetical APA uses. */
export function formatDateAPA(input) {
  const d = parseDateParts(input);
  if (!d) return "(n.d.)";
  if (d.day && d.month) return `(${d.year}, ${FULL_MONTHS[d.month - 1]} ${d.day})`;
  if (d.month) return `(${d.year}, ${FULL_MONTHS[d.month - 1]})`;
  return `(${d.year})`;
}

export function yearOf(input) {
  const d = parseDateParts(input);
  return d ? d.year : null;
}

/** Splits "Jane Q. Smith and John Doe" style strings without breaking "Last, First". */
export function splitAuthors(nameString) {
  if (!nameString) return [];
  const trimmed = nameString.trim();
  if (/\s(and|&)\s/i.test(trimmed)) {
    return trimmed.split(/\s*(?:,?\s+and\s+|\s*&\s*)/i).map((s) => s.trim()).filter(Boolean);
  }
  return [trimmed];
}

const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);

function splitNameParts(fullName) {
  if (fullName.includes(",")) {
    const [last, rest] = fullName.split(",").map((s) => s.trim());
    return { last, first: rest || "" };
  }
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { last: parts[0], first: "" };
  let lastIdx = parts.length - 1;
  while (lastIdx > 0 && NAME_SUFFIXES.has(parts[lastIdx].toLowerCase())) lastIdx--;
  const last = parts.slice(lastIdx).join(" ");
  const first = parts.slice(0, lastIdx).join(" ");
  return { last, first };
}

/** "Jane Q. Smith" -> "Smith, Jane Q." (MLA / Chicago style). */
export function formatNameLastFirst(fullName) {
  const { last, first } = splitNameParts(fullName);
  return first ? `${last}, ${first}` : last;
}

/** "Jane Quinn Smith" -> "Smith, J. Q." (APA style). */
export function formatNameAPA(fullName) {
  const { last, first } = splitNameParts(fullName);
  if (!first) return last;
  const initials = first
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}.`)
    .join(" ");
  return `${last}, ${initials}`;
}

export function formatAuthorListMLA(nameString) {
  const authors = splitAuthors(nameString);
  if (!authors.length) return null;
  if (authors.length === 1) return formatNameLastFirst(authors[0]);
  if (authors.length === 2) return `${formatNameLastFirst(authors[0])}, and ${authors[1]}`;
  return `${formatNameLastFirst(authors[0])}, et al.`;
}

export function formatAuthorListAPA(nameString) {
  const authors = splitAuthors(nameString);
  if (!authors.length) return null;
  if (authors.length === 1) return formatNameAPA(authors[0]);
  if (authors.length <= 20) {
    const formatted = authors.map(formatNameAPA);
    const last = formatted.pop();
    return `${formatted.join(", ")}, & ${last}`;
  }
  const firstNineteen = authors.slice(0, 19).map(formatNameAPA);
  return `${firstNineteen.join(", ")}, . . . ${formatNameAPA(authors[authors.length - 1])}`;
}

export function formatAuthorListChicago(nameString) {
  const authors = splitAuthors(nameString);
  if (!authors.length) return null;
  if (authors.length === 1) return formatNameLastFirst(authors[0]);
  if (authors.length <= 3) {
    const formatted = authors.map((a, i) => (i === 0 ? formatNameLastFirst(a) : a));
    const last = formatted.pop();
    return `${formatted.join(", ")}, and ${last}`;
  }
  return `${formatNameLastFirst(authors[0])} et al.`;
}

/** Title Case for MLA: capitalize principal words, lowercase minor ones (except first/last/after colon). */
export function toTitleCaseMLA(title) {
  if (!title) return title;
  const words = title.trim().split(/\s+/);
  return words
    .map((word, i) => {
      const isBoundary = i === 0 || i === words.length - 1 || words[i - 1].endsWith(":");
      const bare = word.replace(/[.,!?;:]+$/, "");
      if (!isBoundary && MLA_LOWERCASE_WORDS.has(bare.toLowerCase())) {
        return word.toLowerCase();
      }
      if (/^[A-Z0-9]{2,}$/.test(bare)) return word; // keep acronyms as-is
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** Sentence case for APA: only first word, first word after a colon, and existing acronyms stay capitalized. */
export function toSentenceCaseAPA(title) {
  if (!title) return title;
  const parts = title.split(":");
  const rendered = parts.map((part, partIndex) => {
    const words = part.trim().split(/\s+/);
    return words
      .map((word, i) => {
        const bare = word.replace(/[.,!?;]+$/, "");
        if (/^[A-Z0-9]{2,}$/.test(bare)) return word; // acronym, leave alone
        if (i === 0) return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        return word.toLowerCase();
      })
      .join(" ");
  });
  return rendered.join(": ");
}

export function stripLeadingArticle(text) {
  if (!text) return text;
  return text.replace(/^(a|an|the)\s+/i, "");
}

export function ensureTerminalPeriod(text) {
  if (!text) return text;
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

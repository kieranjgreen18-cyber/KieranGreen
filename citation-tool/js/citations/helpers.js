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
  "over", "per", "to", "up", "via", "with", "from", "vs", "vs.", "versus",
]);

const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);

/**
 * True if a word has an uppercase letter anywhere after its first character —
 * "iPhone", "eBay", "macOS", "YouTube". Treated everywhere below as a signal
 * that the source's casing was intentional and should be left completely
 * alone, rather than blindly re-capitalized.
 */
function hasInteriorCapital(word) {
  return /[A-Z]/.test(word.slice(1));
}

function isAcronym(word) {
  return /^[A-Z0-9]{2,}$/.test(word);
}

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

/**
 * Splits a raw typed/extracted author string into one or more individual
 * name strings.
 *
 * Three separators are recognized, tried in this order:
 *   1. ";" — an explicit, unambiguous "one author per segment" separator.
 *      This is the one to reach for with 3+ authors, or with any author
 *      whose own name contains "and" or a comma.
 *   2. " and " / " & " — the common two-author case ("Jane Smith and John Doe").
 *   3. Nothing found — treated as a single author.
 *
 * A bare comma-separated list ("Smith, John, and Jane Doe") is deliberately
 * NOT auto-split on commas: a single "Last, First" name already uses a comma,
 * so there is no reliable way to tell "one person, comma-formatted" from
 * "two people, comma-separated" without guessing. Rather than guess wrong
 * (and silently produce a bad citation), this asks for the unambiguous ";"
 * form instead — the field's placeholder text says so.
 */
export function splitAuthorNames(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.includes(";")) {
    return trimmed.split(";").map((s) => s.trim()).filter(Boolean);
  }
  if (/\s(and|&)\s/i.test(trimmed)) {
    return trimmed.split(/\s*(?:,?\s+and\s+|\s*&\s*)/i).map((s) => s.trim()).filter(Boolean);
  }
  return [trimmed];
}

/**
 * Parses a raw author string into the app's canonical structured shape:
 * an array of { given, family, literal }. `literal` is set for names that
 * don't look like a person (a single word, or a name with 3+ words and no
 * comma — often a corporate/organization author) so styles can print it
 * without inverting it "Last, First"-style.
 *
 * This is the single point where a typed/extracted string becomes structured
 * data — style modules consume the array directly and never re-parse a
 * string themselves.
 */
export function parseAuthors(raw) {
  return splitAuthorNames(raw).map((name) => {
    const { last, first } = splitNameParts(name);
    return { family: last, given: first, literal: name };
  });
}

/** The inverse of parseAuthors: turns a structured author list back into a
 *  single editable string. Uses ";" between authors so it round-trips
 *  exactly through parseAuthors without relying on "and"-splitting. */
export function formatAuthorsForEditing(authors) {
  if (!authors || !authors.length) return "";
  return authors.map((a) => a.literal || [a.given, a.family].filter(Boolean).join(" ")).join("; ");
}

function nameLastFirst(author) {
  if (!author.given) return author.family;
  return `${author.family}, ${author.given}`;
}

function nameAPA(author) {
  if (!author.given) return author.family;
  const initials = author.given
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}.`)
    .join(" ");
  return `${author.family}, ${initials}`;
}

export function formatAuthorListMLA(authors) {
  if (!authors || !authors.length) return null;
  if (authors.length === 1) return nameLastFirst(authors[0]);
  if (authors.length === 2) return `${nameLastFirst(authors[0])}, and ${authors[1].literal || nameLastFirst(authors[1])}`;
  return `${nameLastFirst(authors[0])}, et al.`;
}

export function formatAuthorListAPA(authors) {
  if (!authors || !authors.length) return null;
  if (authors.length === 1) return nameAPA(authors[0]);
  if (authors.length <= 20) {
    const formatted = authors.map(nameAPA);
    const last = formatted.pop();
    return `${formatted.join(", ")}, & ${last}`;
  }
  const firstNineteen = authors.slice(0, 19).map(nameAPA);
  return `${firstNineteen.join(", ")}, . . . ${nameAPA(authors[authors.length - 1])}`;
}

export function formatAuthorListChicago(authors) {
  if (!authors || !authors.length) return null;
  if (authors.length === 1) return nameLastFirst(authors[0]);
  if (authors.length <= 3) {
    const formatted = authors.map((a, i) => (i === 0 ? nameLastFirst(a) : a.literal || nameLastFirst(a)));
    const last = formatted.pop();
    return `${formatted.join(", ")}, and ${last}`;
  }
  return `${nameLastFirst(authors[0])} et al.`;
}

/**
 * Title Case for MLA: capitalize principal words, lowercase minor ones
 * (except first/last/after colon) — but never touch a word that already has
 * its own internal capitalization (brand names, acronyms), since that's
 * reliably intentional and reconstructing it is how you get "eBay" -> "EBay".
 */
export function toTitleCaseMLA(title) {
  if (!title) return title;
  const words = title.trim().split(/\s+/);
  return words
    .map((word, i) => {
      const isBoundary = i === 0 || i === words.length - 1 || words[i - 1].endsWith(":");
      const bare = word.replace(/[.,!?;:]+$/, "");
      if (hasInteriorCapital(bare) || isAcronym(bare)) return word;
      if (!isBoundary && MLA_LOWERCASE_WORDS.has(bare.toLowerCase())) {
        return word.toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * Sentence case for APA. See README for the documented tradeoff: this can't
 * reliably tell a proper noun from an ordinary capitalized word without a
 * proper-noun dictionary or an NLP pass, so it forces the first word (and
 * first word after a colon) to a capital, lowercases the closed set of minor
 * words, and otherwise leaves a word's casing exactly as extracted.
 */
export function toSentenceCaseAPA(title) {
  if (!title) return title;
  const parts = title.split(":");
  const rendered = parts.map((part) => {
    const words = part.trim().split(/\s+/);
    return words
      .map((word, i) => {
        const bare = word.replace(/[.,!?;]+$/, "");
        if (hasInteriorCapital(bare)) return word;
        if (isAcronym(bare)) return word;
        if (i === 0) return word.charAt(0).toUpperCase() + word.slice(1);
        if (MLA_LOWERCASE_WORDS.has(bare.toLowerCase())) return word.toLowerCase();
        return word;
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

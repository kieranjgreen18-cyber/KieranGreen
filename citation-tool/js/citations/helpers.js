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
  const str = String(input).trim();

  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return { year: Number(isoMatch[1]), month: Number(isoMatch[2]), day: Number(isoMatch[3]) };
  }

  // Year-only and year-month must be caught BEFORE new Date(), which
  // helpfully invents the missing pieces: new Date("2022") is 1 Jan 2022,
  // so a source that only published a year was being cited with a precise
  // day it never claimed. Fabricating precision is worse than omitting it.
  const yearMonth = str.match(/^(\d{4})-(\d{2})$/);
  if (yearMonth) return { year: Number(yearMonth[1]), month: Number(yearMonth[2]), day: null };

  if (/^\d{4}$/.test(str)) return { year: Number(str), month: null, day: null };

  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return { year: parsed.getUTCFullYear(), month: parsed.getUTCMonth() + 1, day: parsed.getUTCDate() };
  }

  const yearOnly = str.match(/(\d{4})/);
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
 * Words that mark a name as an organization rather than a person. All three
 * style guides print a corporate author as-is ("World Health Organization.")
 * and never invert it to "Organization, World Health" — which is exactly
 * what a naive Last/First split produces, since "World Health Organization"
 * looks structurally identical to "Jane Quinn Smith".
 */
const ORG_WORDS = new RegExp(
  "\\b(organization|organisation|institute|institution|university|college|school|academy|" +
  "department|association|society|foundation|cent(?:er|re)|council|committee|bureau|agency|" +
  "ministry|commission|corporation|company|incorporated|inc|ltd|llc|llp|plc|gmbh|group|press|" +
  "publishers?|news|times|post|journal|network|services?|administration|office|board|union|" +
  "federation|league|alliance|trust|museum|library|authority|programme|program|fund|bank|" +
  "project|initiative|coalition|partnership|team|staff|editors?|government|nations|" +
  "laboratory|labs?|clinic|hospital|health|research)\\b",
  "i"
);

/** True when a name should be printed verbatim rather than inverted. */
function looksCorporate(name) {
  const trimmed = name.trim();
  // An explicit "Last, First" comma is a strong signal of a personal name.
  if (trimmed.includes(",")) return false;
  if (ORG_WORDS.test(trimmed)) return true;
  // Four or more words with no comma is far more often an organization than
  // a person ("Centers for Disease Control and Prevention"); three-word
  // personal names ("Jane Quinn Smith") stay safely below this line.
  if (trimmed.split(/\s+/).filter(Boolean).length >= 4) return true;
  // Contains a lowercase function word ("Friends of the Earth").
  if (/\s(of|for|the|and|on|in)\s/.test(trimmed)) return true;
  return false;
}

/**
 * Parses a raw author string into the app's canonical structured shape:
 * an array of { given, family, literal, isCorporate }. A corporate author
 * keeps its whole name in `family` with an empty `given`, so every style
 * module renders it verbatim — sorting still works, because sorting only
 * ever reads `family`.
 *
 * This is the single point where a typed/extracted string becomes structured
 * data — style modules consume the array directly and never re-parse a
 * string themselves.
 */
export function parseAuthors(raw) {
  return splitAuthorNames(raw).map((name) => {
    if (looksCorporate(name)) {
      return { family: name.trim(), given: "", literal: name.trim(), isCorporate: true };
    }
    const { last, first } = splitNameParts(name);
    return { family: last, given: first, literal: name, isCorporate: false };
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

/**
 * Chicago BIBLIOGRAPHY form (CMOS 17, 14.76) — not the note form, which is
 * what the "first author + et al. at 4 or more" rule everyone remembers
 * actually applies to. A bibliography entry lists every author up to ten;
 * only at eleven or more does it list the first seven followed by et al.
 * Only the first author is inverted to "Last, First".
 */
export function formatAuthorListChicago(authors) {
  if (!authors || !authors.length) return null;
  if (authors.length === 1) return nameLastFirst(authors[0]);

  if (authors.length > 10) {
    const firstSeven = authors.slice(0, 7).map((a, i) => (i === 0 ? nameLastFirst(a) : a.literal || nameLastFirst(a)));
    return `${firstSeven.join(", ")}, et al.`;
  }

  const formatted = authors.map((a, i) => (i === 0 ? nameLastFirst(a) : a.literal || nameLastFirst(a)));
  const last = formatted.pop();
  return `${formatted.join(", ")}, and ${last}`;
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

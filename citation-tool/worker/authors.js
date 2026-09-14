// Author parsing shared between direct-scrape metadata normalization and
// the identifier-based resolvers (Crossref/arXiv/PubMed give authors in
// their own structured shapes; a scraped page usually only gives a string
// or a JSON-LD author field). Both paths converge on the same canonical
// shape the frontend consumes: an array of { family, given, literal }.

function extractAuthorNames(authorField) {
  if (!authorField) return [];
  if (typeof authorField === "string") return authorField.trim() ? [authorField.trim()] : [];
  if (Array.isArray(authorField)) return authorField.flatMap(extractAuthorNames);
  if (typeof authorField === "object") return authorField.name ? [String(authorField.name).trim()] : [];
  return [];
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

/** Mirrors the frontend's splitAuthorNames (citations/helpers.js): only ";"
 *  or " and "/" & " split a single string into multiple people. A bare
 *  comma-separated list ("Smith, John, Doe, Jane") is ambiguous with a
 *  single "Last, First" name and is deliberately not guessed at. */
function splitAuthorString(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return [];
  if (trimmed.includes(";")) return trimmed.split(";").map((s) => s.trim()).filter(Boolean);
  if (/\s(and|&)\s/i.test(trimmed)) {
    return trimmed.split(/\s*(?:,?\s+and\s+|\s*&\s*)/i).map((s) => s.trim()).filter(Boolean);
  }
  return [trimmed];
}

/** Builds the app's canonical structured author list — an array of
 *  { family, given, literal } — from whatever a scraped page exposed.
 *  JSON-LD's own author field (when present) is trusted as already-discrete
 *  people rather than joined into a string and re-split; a plain meta-tag
 *  string falls back to splitAuthorString. */
export function buildAuthors(jsonLdAuthorField, metaAuthorString) {
  const names = extractAuthorNames(jsonLdAuthorField);
  const raw = names.length ? names : splitAuthorString(metaAuthorString);
  return raw.filter(Boolean).map((name) => {
    const { last, first } = splitNameParts(name);
    return { family: last, given: first, literal: name };
  });
}

/** For resolvers that already have discrete given/family pairs (Crossref,
 *  PubMed) rather than a name string to parse. */
export function authorsFromParts(parts) {
  return (parts || [])
    .filter((p) => p && (p.family || p.given))
    .map((p) => ({
      family: p.family || p.given,
      given: p.family ? p.given || "" : "",
      literal: [p.given, p.family].filter(Boolean).join(" ") || p.family,
    }));
}

export function joinAuthorsRaw(authors) {
  return (authors || []).map((a) => a.literal).join("; ") || null;
}

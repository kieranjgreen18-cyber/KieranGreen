/**
 * Citation Tool — Cloudflare Worker backend
 * ------------------------------------------
 * Endpoints:
 *   GET  /api/metadata?url=<encoded>&type=webpage|image&pageUrl=<encoded optional>
 *   POST /api/ai-suggest        { url, sourceType, style, knownFields, missingField }
 *   GET  /api/health
 *
 * Secrets (set with `wrangler secret put ...`):
 *   ANTHROPIC_API_KEY   — optional. If absent, /api/ai-suggest returns ai_not_configured
 *                          and the frontend simply hides AI suggestions.
 *
 * Vars (set in wrangler.toml [vars] or dashboard):
 *   ALLOWED_ORIGIN      — the exact origin your GitHub Pages / custom domain is served
 *                          from, e.g. "https://citations.example.com". Use "*" only
 *                          while developing locally.
 *
 * Nothing here reads or writes a database — every request is stateless. The Worker's
 * only job is to do the things a browser can't do safely or reliably itself: fetch
 * third-party pages without being blocked by CORS, and call the Anthropic API without
 * putting a secret key in client-side code.
 */

const JSON_HEADERS = { "content-type": "application/json;charset=UTF-8" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    try {
      let response;
      if (url.pathname === "/api/metadata" && request.method === "GET") {
        response = await handleMetadata(url, env);
      } else if (url.pathname === "/api/ai-suggest" && request.method === "POST") {
        response = await handleAiSuggest(request, env);
      } else if (url.pathname === "/api/health") {
        response = json({ ok: true, aiConfigured: Boolean(env.ANTHROPIC_API_KEY) });
      } else {
        response = json({ ok: false, error: "not_found" }, 404);
      }
      return withCors(response, origin);
    } catch (err) {
      return withCors(
        json({ ok: false, error: "internal_error", message: String(err && err.message || err) }, 500),
        origin
      );
    }
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(origin);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

/* --------------------------------------------------------------------- *
 *  /api/metadata
 * --------------------------------------------------------------------- */

async function handleMetadata(url, env) {
  const target = url.searchParams.get("url");
  const sourceType = url.searchParams.get("type") || "webpage";
  const pageUrlParam = url.searchParams.get("pageUrl");

  if (!target) return json({ ok: false, error: "missing_url" }, 400);

  let targetUrl;
  try {
    targetUrl = new URL(target);
    if (!/^https?:$/.test(targetUrl.protocol)) throw new Error("bad_protocol");
  } catch {
    return json({ ok: false, error: "invalid_url" }, 400);
  }

  // For images, prefer scraping the *page the image lives on* when we have it —
  // that's where the creator/title/date usually actually live. The raw image
  // URL is kept as the citation's image URL regardless.
  const scrapeTarget = sourceType === "image" && pageUrlParam ? pageUrlParam : target;

  let scrapeUrl;
  try {
    scrapeUrl = new URL(scrapeTarget);
  } catch {
    scrapeUrl = targetUrl;
  }

  const fetched = await safeFetch(scrapeUrl.toString());

  if (!fetched.ok) {
    // If scraping a referring page failed for an image, still return the raw
    // image URL so the frontend can fall back to manual/AI-assisted fields.
    return json({
      ok: false,
      error: fetched.error,
      message: fetched.message,
      type: sourceType,
      url: target,
    }, fetched.status || 502);
  }

  if (fetched.isImage) {
    return json({
      ok: true,
      type: "image",
      url: target,
      resolvedUrl: fetched.finalUrl,
      fields: {
        imageUrl: target,
        siteName: hostnameLabel(targetUrl.hostname),
      },
      note: "The URL pointed directly at an image file, so no page metadata was available.",
    });
  }

  if (fetched.isOther) {
    return json({
      ok: false,
      error: "unsupported_content_type",
      message: `Server returned ${fetched.contentType}, which isn't a webpage or image.`,
      type: sourceType,
      url: target,
    }, 415);
  }

  const fields = normalizeFields(fetched.data, scrapeUrl, sourceType, target);

  return json({
    ok: true,
    type: sourceType,
    url: target,
    resolvedUrl: fetched.finalUrl,
    fields,
    raw: {
      jsonLdCount: fetched.data.jsonLd.length,
      hasOpenGraph: Object.keys(fetched.data.metaByProperty).length > 0,
    },
  });
}

async function safeFetch(targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(targetUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; CitationToolBot/1.0; +https://github.com/) AppleWebKit/537.36",
        accept: "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5",
      },
      cf: { cacheTtl: 300, cacheEverything: false },
    });

    const contentType = (res.headers.get("content-type") || "").toLowerCase();

    if (!res.ok) {
      return { ok: false, error: "fetch_failed", message: `Source responded with ${res.status}`, status: 502 };
    }
    if (contentType.startsWith("image/")) {
      return { ok: true, isImage: true, contentType, finalUrl: res.url };
    }
    if (!contentType.includes("html")) {
      return { ok: true, isOther: true, contentType, finalUrl: res.url };
    }

    const data = await extractHtmlMetadata(res);
    return { ok: true, data, finalUrl: res.url };
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "timeout" : "fetch_failed",
      message: aborted ? "The source took too long to respond." : String(err && err.message || err),
      status: aborted ? 504 : 502,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Drains an HTMLRewriter pass over the response and returns collected metadata. */
async function extractHtmlMetadata(res) {
  const data = {
    title: "",
    metaByProperty: {},
    metaByName: {},
    links: {},
    jsonLd: [],
    _jsonLdBuffer: "",
    _inJsonLd: false,
  };

  const rewriter = new HTMLRewriter()
    .on("title", {
      text(chunk) {
        data.title += chunk.text;
      },
    })
    .on("meta", {
      element(el) {
        const property = el.getAttribute("property");
        const name = el.getAttribute("name");
        const content = el.getAttribute("content");
        if (content == null) return;
        if (property) data.metaByProperty[property.toLowerCase()] = content;
        if (name) data.metaByName[name.toLowerCase()] = content;
      },
    })
    .on("link", {
      element(el) {
        const rel = (el.getAttribute("rel") || "").toLowerCase();
        const href = el.getAttribute("href");
        if (!href) return;
        if (rel.includes("icon")) data.links.icon = href;
        if (rel === "canonical") data.links.canonical = href;
      },
    })
    .on('script[type="application/ld+json"]', {
      text(chunk) {
        data._jsonLdBuffer += chunk.text;
        if (chunk.lastInTextNode) {
          const raw = data._jsonLdBuffer.trim();
          data._jsonLdBuffer = "";
          if (raw) {
            try {
              data.jsonLd.push(JSON.parse(raw));
            } catch {
              // Some sites emit malformed or multiple concatenated JSON-LD blocks.
              // Skip silently rather than guessing at a repair.
            }
          }
        }
      },
    });

  const transformed = rewriter.transform(res);
  // Force the stream to fully drain so every handler above actually fires.
  await transformed.arrayBuffer();

  data.title = data.title.trim();
  return data;
}

/** Flattens JSON-LD (including @graph) into a list of candidate node objects. */
function flattenJsonLd(blocks) {
  const nodes = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (Array.isArray(node["@graph"])) {
      node["@graph"].forEach(visit);
    }
    nodes.push(node);
  };
  blocks.forEach(visit);
  return nodes;
}

function jsonLdTypeMatches(node, types) {
  const t = node["@type"];
  if (!t) return false;
  const list = Array.isArray(t) ? t : [t];
  return list.some((x) => types.includes(String(x)));
}

function extractAuthorName(authorField) {
  if (!authorField) return null;
  if (typeof authorField === "string") return authorField.trim() || null;
  if (Array.isArray(authorField)) {
    const names = authorField.map(extractAuthorName).filter(Boolean);
    return names.length ? names.join(", ") : null;
  }
  if (typeof authorField === "object") {
    return authorField.name || null;
  }
  return null;
}

function lastNameFromFullName(fullName) {
  if (!fullName) return null;
  const cleaned = fullName.trim();
  if (cleaned.includes(",")) {
    // Already "Last, First"
    return cleaned.split(",")[0].trim();
  }
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  // Keep common suffixes attached to the previous token rather than treated as the surname.
  const suffixes = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);
  let lastIdx = parts.length - 1;
  while (lastIdx > 0 && suffixes.has(parts[lastIdx].toLowerCase())) lastIdx--;
  return parts[lastIdx];
}

function hostnameLabel(hostname) {
  return hostname.replace(/^www\./, "");
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

function normalizeFields(data, resolvedUrl, sourceType, originalUrl) {
  const og = data.metaByProperty;
  const meta = data.metaByName;
  const nodes = flattenJsonLd(data.jsonLd);

  const articleNode = nodes.find((n) =>
    jsonLdTypeMatches(n, ["Article", "NewsArticle", "BlogPosting", "Report", "ScholarlyArticle", "WebPage"])
  );
  const imageNode = nodes.find((n) => jsonLdTypeMatches(n, ["ImageObject", "Photograph"]));
  const orgNode = nodes.find((n) => jsonLdTypeMatches(n, ["Organization", "WebSite"]));

  const primaryNode = sourceType === "image" ? imageNode || articleNode : articleNode || imageNode;

  const authorRaw = primaryNode && primaryNode.author;
  const authorName = extractAuthorName(authorRaw) || firstNonEmpty(meta["author"], og["article:author"]);

  const publisherName = firstNonEmpty(
    primaryNode && primaryNode.publisher && primaryNode.publisher.name,
    orgNode && orgNode.name,
    og["og:site_name"],
    meta["publisher"]
  );

  const title = firstNonEmpty(
    primaryNode && (primaryNode.headline || primaryNode.name),
    og["og:title"],
    data.title
  );

  const datePublished = firstNonEmpty(
    primaryNode && primaryNode.datePublished,
    og["article:published_time"],
    meta["date"],
    meta["pubdate"],
    meta["publish-date"]
  );

  const dateModified = firstNonEmpty(
    primaryNode && primaryNode.dateModified,
    og["article:modified_time"],
    meta["last-modified"]
  );

  const description = firstNonEmpty(
    primaryNode && primaryNode.description,
    og["og:description"],
    meta["description"]
  );

  const image = firstNonEmpty(
    primaryNode && primaryNode.image && (primaryNode.image.url || primaryNode.image),
    og["og:image"]
  );

  const siteName = firstNonEmpty(publisherName, og["og:site_name"], hostnameLabel(resolvedUrl.hostname));

  const fields = {
    title,
    author: authorName,
    authorLastName: lastNameFromFullName(authorName),
    siteName,
    publisher: publisherName,
    datePublished,
    dateModified,
    description,
    url: sourceType === "image" ? originalUrl : resolvedUrl.toString(),
    favicon: data.links.icon ? new URL(data.links.icon, resolvedUrl).toString() : null,
  };

  if (sourceType === "image") {
    fields.imageUrl = originalUrl;
    fields.imageTitle = title;
    fields.creator = authorName;
    if (image) fields.pageHeroImage = new URL(image, resolvedUrl).toString();
  }

  return fields;
}

/* --------------------------------------------------------------------- *
 *  /api/ai-suggest
 * --------------------------------------------------------------------- */

async function handleAiSuggest(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ ok: false, reason: "ai_not_configured" }, 501);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400);
  }

  const { url, sourceType, style, knownFields, missingField } = body || {};
  if (!url || !missingField) {
    return json({ ok: false, error: "missing_params" }, 400);
  }

  const knownSummary = Object.entries(knownFields || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n") || "(none)";

  const prompt = `You are helping compile an accurate ${style || "academic"} citation for a source.

Source URL: ${url}
Source type: ${sourceType || "webpage"}
Fields already known:
${knownSummary}

The single missing field to research is: "${missingField}".

Use web search to find reliable, verifiable evidence for this field. Prefer the
source's own byline, masthead, "about" page, or official metadata over third-party
mentions. If you cannot find reliable evidence, say so — do not guess.

Respond with ONLY a single JSON object (no markdown, no commentary) in exactly
this shape:
{"found": true|false, "value": "<string or null>", "evidenceUrl": "<string or null>", "confidence": "high"|"medium"|"low", "note": "<one short sentence>"}`;

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      // Override with an ANTHROPIC_MODEL var/secret if Anthropic has since
      // shipped a newer model you'd rather use — check docs.claude.com for
      // the current lineup and model id.
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
      max_tokens: 700,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!anthropicRes.ok) {
    const text = await anthropicRes.text();
    return json({ ok: false, error: "ai_request_failed", message: text.slice(0, 300) }, 502);
  }

  const data = await anthropicRes.json();
  const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
  const combined = textBlocks.join("\n").trim();

  let parsed;
  try {
    const jsonMatch = combined.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : combined);
  } catch {
    return json({ ok: false, error: "unparseable_ai_response" }, 502);
  }

  if (!parsed.found || !parsed.value) {
    return json({ ok: true, found: false, note: parsed.note || "No reliable source found." });
  }

  return json({
    ok: true,
    found: true,
    field: missingField,
    value: parsed.value,
    evidenceUrl: parsed.evidenceUrl || null,
    confidence: parsed.confidence || "low",
    note: parsed.note || "",
  });
}

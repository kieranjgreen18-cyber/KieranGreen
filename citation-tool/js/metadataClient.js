import { API_BASE } from "./config.js";

/**
 * Asks the Worker to fetch and parse a source's metadata.
 * @param {string} url - the URL to cite (page URL, direct image URL, or a
 *   shared AI-conversation URL).
 * @param {'webpage'|'image'|'ai'} type
 * @param {string|null} pageUrl - for images, the page the image was found on, if known.
 */
export async function fetchMetadata(url, type, pageUrl) {
  const qs = new URLSearchParams({ url, type });
  if (pageUrl) qs.set("pageUrl", pageUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${API_BASE}/api/metadata?${qs.toString()}`, { signal: controller.signal });
    const data = await res.json().catch(() => null);
    if (!data) return { ok: false, error: "bad_response" };
    return data;
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : "network_error", message: String(err && err.message || err) };
  } finally {
    clearTimeout(timeout);
  }
}

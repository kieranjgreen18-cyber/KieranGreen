import { API_BASE, AI_SUGGESTIONS_ENABLED } from "./config.js";

let aiAvailable = null; // null = unknown yet, true/false once checked

export async function checkAiAvailability() {
  if (!AI_SUGGESTIONS_ENABLED) return false;
  if (aiAvailable !== null) return aiAvailable;
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const data = await res.json();
    aiAvailable = Boolean(data && data.aiConfigured);
  } catch {
    aiAvailable = false;
  }
  return aiAvailable;
}

/**
 * Asks the AI-assisted fallback to research a single missing field.
 * Returns { ok, found, value, evidenceUrl, confidence, note } — never throws.
 */
export async function requestAiSuggestion({ url, sourceType, style, knownFields, missingField }) {
  try {
    const res = await fetch(`${API_BASE}/api/ai-suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, sourceType, style, knownFields, missingField }),
    });
    const data = await res.json();
    return data;
  } catch (err) {
    return { ok: false, error: "network_error", message: String(err && err.message || err) };
  }
}

/* ===================================================================
 * YOUR SETTINGS — this is the only file you need to edit, and the
 * update script (scripts/update-citer.sh) never overwrites it.
 * Set it once; future versions of Citer drop in around it.
 * =================================================================== */

/** Your deployed Cloudflare Worker. Either the workers.dev URL or a
 *  custom route on your own domain — whichever you set up. */
const PRODUCTION_API = "https://citation-tool-api.YOUR-SUBDOMAIN.workers.dev";

/** Used automatically when you're on localhost/127.0.0.1, so you can run
 *  `wrangler dev` against a local Worker without editing this file back
 *  and forth. Set it to PRODUCTION_API if you'd rather always hit the
 *  deployed one. */
const LOCAL_API = "http://localhost:8787";

/** Set to false to hide the "Research with AI" affordance entirely,
 *  regardless of whether the backend has a key configured. */
export const AI_SUGGESTIONS_ENABLED = true;

/* ===================================================================
 * Resolution logic — you shouldn't need to touch anything below.
 * =================================================================== */

function resolveApiBase() {
  // A localStorage override beats everything. Handy for pointing a
  // deployed page at a local Worker while debugging, without a rebuild:
  //   localStorage.setItem("citer:api-base", "http://localhost:8787")
  // Remove it with: localStorage.removeItem("citer:api-base")
  try {
    const override = localStorage.getItem("citer:api-base");
    if (override) return override.replace(/\/+$/, "");
  } catch {
    /* storage unavailable (private mode) — fall through */
  }

  const host = location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".local");
  return (isLocal ? LOCAL_API : PRODUCTION_API).replace(/\/+$/, "");
}

export const API_BASE = resolveApiBase();

/** True while API_BASE is still the shipped placeholder. main.js uses
 *  this to show a single clear setup message instead of letting every
 *  source fail with an opaque CORS/network error. */
export const API_BASE_UNCONFIGURED = /YOUR-SUBDOMAIN/.test(API_BASE);

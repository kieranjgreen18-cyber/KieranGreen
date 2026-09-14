// Point this at your deployed Cloudflare Worker (see /worker/README in the
// project root, or the main README's "Deploying the backend" section).
// Example once deployed: "https://citation-tool-api.yourname.workers.dev"
// or a custom route on your existing Cloudflare domain, e.g.
// "https://api.yourdomain.com".
export const API_BASE = "https://citation-tool-api.kieranjgreen18.workers.dev/";

// Toggle to false to hide the "Search for missing info" AI affordance
// entirely regardless of whether the backend has a key configured.
export const AI_SUGGESTIONS_ENABLED = true;

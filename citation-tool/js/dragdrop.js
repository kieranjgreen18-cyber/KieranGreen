import { isValidHttpUrl, looksLikeImageUrl } from "./utils.js";

function parseUriList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Reads whatever the browser actually exposed on a drop event and turns it
 * into one or more citation candidates. Different browsers/sources expose
 * different DataTransfer types, so this checks several in priority order
 * rather than assuming one shape:
 *   1. Real files (image dragged from the user's file system)
 *   2. text/uri-list (tabs, links — can contain more than one URL)
 *   3. text/x-moz-url (Firefox's "URL\nTitle" format)
 *   4. text/html (used to spot an <img src> when an image element itself was dragged)
 *   5. text/plain, as a last resort, if it happens to be a bare URL
 */
export async function extractDragCandidates(dataTransfer) {
  if (dataTransfer.files && dataTransfer.files.length) {
    const fileCandidates = [];
    for (const file of Array.from(dataTransfer.files)) {
      if (!file.type.startsWith("image/")) continue;
      const fileDataUrl = await readFileAsDataUrl(file).catch(() => null);
      fileCandidates.push({
        type: "image",
        url: null,
        pageUrl: null,
        titleHint: file.name.replace(/\.[a-z0-9]+$/i, ""),
        file,
        fileDataUrl,
        missingInfoNote:
          "Dragged from your computer, so there's no page to pull metadata from — add the creator, title, and date manually, or add the source's URL for AI-assisted lookup.",
      });
    }
    if (fileCandidates.length) return fileCandidates;
  }

  const types = dataTransfer.types ? Array.from(dataTransfer.types) : [];
  let urls = [];
  let titleHint = null;

  if (types.includes("text/uri-list")) {
    urls = parseUriList(dataTransfer.getData("text/uri-list"));
  }

  if (types.includes("text/x-moz-url")) {
    const raw = dataTransfer.getData("text/x-moz-url");
    const [urlPart, titlePart] = raw.split("\n");
    if (!urls.length && urlPart) urls = [urlPart.trim()];
    if (titlePart) titleHint = titlePart.trim();
  }

  let htmlImageUrl = null;
  if (types.includes("text/html")) {
    const html = dataTransfer.getData("text/html");
    const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) htmlImageUrl = match[1];
  }

  if (!urls.length && types.includes("text/plain")) {
    const plain = dataTransfer.getData("text/plain").trim();
    if (isValidHttpUrl(plain)) urls = [plain];
  }

  // An <img> in the dragged HTML fragment is a strong signal the user meant
  // to drag an image, even if a page URL also showed up in text/uri-list.
  if (htmlImageUrl && (!urls.length || (!looksLikeImageUrl(urls[0]) && looksLikeImageUrl(htmlImageUrl)))) {
    return [
      {
        type: "image",
        url: htmlImageUrl,
        pageUrl: urls[0] || null,
        titleHint,
        missingInfoNote: urls[0]
          ? null
          : "The page this image came from wasn't included in the drag data, so creator and date may need manual entry or AI assistance.",
      },
    ];
  }

  if (urls.length) {
    return urls
      .filter((u) => isValidHttpUrl(u))
      .map((url) => ({
        type: looksLikeImageUrl(url) ? "image" : "webpage",
        url,
        pageUrl: null,
        titleHint,
        missingInfoNote: null,
      }));
  }

  return [
    {
      type: "unknown",
      url: null,
      pageUrl: null,
      titleHint: null,
      missingInfoNote:
        "This browser or item didn't expose a URL, image, or file through drag-and-drop. Use the manual link field below instead.",
    },
  ];
}

/**
 * Wires a drop zone element to real native drag-and-drop events.
 * onDrop receives an array of candidates from extractDragCandidates.
 */
export function attachDropZone(el, { onDrop, onDragStateChange }) {
  let dragDepth = 0;

  const setActive = (active) => {
    el.classList.toggle("is-drag-active", active);
    if (onDragStateChange) onDragStateChange(active);
  };

  el.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth += 1;
    setActive(true);
  });

  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });

  el.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setActive(false);
  });

  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    setActive(false);
    const candidates = await extractDragCandidates(e.dataTransfer);
    onDrop(candidates);
  });
}

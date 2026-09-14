import { extractUrlsFromText } from "./utils.js";

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
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
 * Listens for Ctrl/Cmd+V anywhere on the page that ISN'T already a text
 * field (the manual-URL input, a citation edit field, etc. — those keep
 * their normal paste behavior). A paste containing one or more URLs is
 * intercepted and turned into sources immediately; this is the app's
 * primary bulk-import path, so it deliberately doesn't require the person
 * to first click into the drop zone.
 *
 * `onUrls` receives the full list of URLs found in the pasted text, in
 * the order they appeared — the caller decides webpage vs. image per URL.
 * `onImageFile` receives an image if the clipboard held one directly
 * (e.g. a copied screenshot) rather than a URL.
 *
 * `onPlainText`, if provided, fires when the paste held neither a URL nor
 * an image — a block of ordinary prose. The caller decides what (if
 * anything) that means; today that's "treat it as a pasted AI response"
 * when the AI source type is selected, but this module doesn't know or
 * care about that — it just hands back what didn't match anything else.
 */
export function attachBulkPaste({ onUrls, onImageFile, onPlainText, onFlash }) {
  document.addEventListener("paste", async (e) => {
    if (isEditableTarget(e.target)) return;

    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    const text = clipboardData.getData("text/plain") || "";
    const urls = extractUrlsFromText(text);

    if (urls.length) {
      e.preventDefault();
      onUrls(urls);
      if (onFlash) onFlash(`Added ${urls.length} source${urls.length === 1 ? "" : "s"} from paste`);
      return;
    }

    const files = Array.from(clipboardData.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length && onImageFile) {
      e.preventDefault();
      for (const file of files) {
        const fileDataUrl = await readFileAsDataUrl(file).catch(() => null);
        onImageFile({ file, fileDataUrl, titleHint: null });
      }
      if (onFlash) onFlash(`Added ${files.length} image${files.length === 1 ? "" : "s"} from paste`);
      return;
    }

    if (text.trim().length > 20 && onPlainText) {
      const handled = onPlainText(text.trim());
      if (handled) {
        e.preventDefault();
        if (onFlash) onFlash("Added as a pasted AI response");
      }
    }
  });
}

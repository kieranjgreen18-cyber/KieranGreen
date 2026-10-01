// Word and Google Docs both understand inline CSS hanging-indent on a <p>,
// so that's what we paste as HTML. The matching text/plain payload has no
// markup at all, per the "true plaintext" requirement.
//
// MLA and APA Works Cited/References pages are double-spaced *throughout*,
// including between entries — there's no extra paragraph gap on top of that,
// which is what line-height: 2 with zero margin gives you here. (An earlier
// version used line-height: 1.6 plus a 1em bottom margin, which was neither
// real double-spacing nor the no-extra-gap convention — fixed.)
const HANGING_INDENT_STYLE =
  "margin:0;padding-left:0.5in;text-indent:-0.5in;line-height:2;font-family:'Times New Roman',Times,serif;font-size:12pt;";

export function buildBibliographyHtml(completedSources) {
  const items = completedSources
    .filter((s) => s.citation && s.citation.html)
    .map((s) => `<p style="${HANGING_INDENT_STYLE}">${s.citation.html}</p>`)
    .join("\n");
  // Times New Roman 12pt is what MLA, APA and Chicago all effectively expect
  // for a submitted paper, and it's what Word/Google Docs will honor on
  // paste. The inline font-family is repeated on each <p> as well as the
  // wrapper, because Google Docs drops the container's font when pasting a
  // block and falls back to the document default otherwise.
  return `<div style="font-family:'Times New Roman',Times,serif;font-size:12pt;">${items}</div>`;
}

export function buildBibliographyPlaintext(completedSources) {
  return completedSources
    .filter((s) => s.citation && s.citation.plaintext)
    .map((s) => s.citation.plaintext)
    .join("\n\n");
}

export async function copyRichAndPlain(html, plain) {
  if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    try {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      return true;
    } catch {
      // Fall through to plain-text-only copy below.
    }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(plain);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }
  return legacyCopy(plain);
}

// document.execCommand("copy") is formally deprecated, and is kept here
// deliberately rather than removed: it is only ever reached after BOTH
// navigator.clipboard.write and .writeText have already failed or are
// unavailable. That still happens in real conditions — notably on
// non-secure origins (plain http://, which the async Clipboard API refuses
// outright) and in a few older mobile browsers. Every current browser
// continues to support it, and the alternative in those cases isn't a
// better API, it's the copy button silently doing nothing.
function legacyCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

#!/usr/bin/env bash
#
# update-citer.sh — drop a new version of Citer into your existing site
# without touching the things you configured.
#
#   ./scripts/update-citer.sh /path/to/your-portfolio-repo
#
# Run it from inside the NEW version's folder (the one you just unzipped).
# It copies the app into <your-repo>/citation/ and deliberately preserves:
#
#   citation/js/config.js     your Worker URL and AI toggle
#   citation/assets/fonts/    your licensed font files
#   citation/CNAME            if you keep one in there
#
# Everything else is replaced wholesale, so removed/renamed files don't
# linger. Safe to run repeatedly; it makes no changes outside citation/.
#
# Flags:
#   --dry-run    show what would change, touch nothing
#   --subdir X   deploy into <repo>/X instead of <repo>/citation

set -euo pipefail

SUBDIR="citation"
DRY_RUN=0
TARGET_REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --subdir)  SUBDIR="${2:?--subdir needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *)         TARGET_REPO="$1"; shift ;;
  esac
done

if [[ -z "$TARGET_REPO" ]]; then
  echo "usage: $0 [--dry-run] [--subdir citation] /path/to/your-repo" >&2
  exit 1
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${TARGET_REPO%/}/${SUBDIR}"

if [[ ! -f "$SRC/index.html" ]]; then
  echo "error: run this from inside the new Citer folder (no index.html at $SRC)" >&2
  exit 1
fi
if [[ ! -d "$TARGET_REPO" ]]; then
  echo "error: no such directory: $TARGET_REPO" >&2
  exit 1
fi

echo "  source: $SRC"
echo "  target: $DEST"
[[ $DRY_RUN -eq 1 ]] && echo "  (dry run — nothing will be written)"
echo

# Stash the files that are yours, not mine.
PRESERVE=("js/config.js" "CNAME")
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for rel in "${PRESERVE[@]}"; do
  if [[ -f "$DEST/$rel" ]]; then
    mkdir -p "$TMP/$(dirname "$rel")"
    cp "$DEST/$rel" "$TMP/$rel"
    echo "  preserving $rel"
  fi
done

if [[ -d "$DEST/assets/fonts" ]] && compgen -G "$DEST/assets/fonts/*.woff2" > /dev/null; then
  mkdir -p "$TMP/assets/fonts"
  cp "$DEST"/assets/fonts/*.woff2 "$TMP/assets/fonts/"
  echo "  preserving assets/fonts/*.woff2"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "would sync these into $DEST:"
  ( cd "$SRC" && find . -type f \
      -not -path "./worker/*" -not -path "./scripts/*" \
      -not -path "./.git/*" -not -name ".DS_Store" | sort | sed 's/^\./  /' )
  exit 0
fi

# Replace the app directory wholesale so stale files don't survive.
rm -rf "$DEST"
mkdir -p "$DEST"

# The Worker isn't served by Pages, and neither are these scripts.
( cd "$SRC" && find . -type f \
    -not -path "./worker/*" -not -path "./scripts/*" \
    -not -path "./.git/*" -not -name ".DS_Store" \
    -exec install -D -m 644 {} "$DEST/{}" \; )

# Put your files back on top.
if [[ -d "$TMP" ]]; then
  ( cd "$TMP" && find . -type f -exec install -D -m 644 {} "$DEST/{}" \; ) 2>/dev/null || true
fi

echo
echo "done. next:"
echo "  cd ${TARGET_REPO%/}"
echo "  git add ${SUBDIR} && git commit -m 'Update Citer' && git push"
echo
# Match the placeholder URL specifically — a bare "YOUR-SUBDOMAIN" also
# appears in config.js's own detection regex, which would warn every time.
if grep -q 'PRODUCTION_API = "https://citation-tool-api.YOUR-SUBDOMAIN' "$DEST/js/config.js" 2>/dev/null; then
  echo "  NOTE: js/config.js still has the placeholder Worker URL."
  echo "        Set PRODUCTION_API in ${SUBDIR}/js/config.js — this was a"
  echo "        first install, so there was no existing config to preserve."
fi

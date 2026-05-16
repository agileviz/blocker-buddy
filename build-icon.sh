#!/usr/bin/env bash
#
# build-icon.sh — render the BB icon SVG to PNG for the marketplace VSIX.
#
# Source of truth: imagesrc/icon.svg. Edit there, re-run this script,
# static/icon.png updates. ADO Marketplace rejects packages that contain
# any SVG file, so the SVG stays in imagesrc/ (not packaged in the VSIX)
# and only the rendered PNG ships in static/.
#
# Note: the AgileViz Hugo site at agileviz.com/plugins/blocker-buddy/ keeps
# its own copy of icon.svg (the support-page card renders the SVG natively).
# If you change the icon, also update the Hugo site's copy.
#
# Requires: librsvg (`brew install librsvg`). The CLI is `rsvg-convert`.
#
# Usage:
#   ./build-icon.sh

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SOURCE_SVG="${SCRIPT_DIR}/imagesrc/icon.svg"
PLUGIN_PNG="${SCRIPT_DIR}/static/icon.png"

ICON_SIZE="512"

# ── Pre-flight checks ────────────────────────────────────────────────────────

if ! command -v rsvg-convert >/dev/null 2>&1; then
    echo "Error: rsvg-convert not found." >&2
    echo "Install: brew install librsvg" >&2
    exit 1
fi

if [[ ! -f "${SOURCE_SVG}" ]]; then
    echo "Error: source SVG missing: ${SOURCE_SVG}" >&2
    exit 1
fi

# ── Render ───────────────────────────────────────────────────────────────────

mkdir -p "$(dirname "${PLUGIN_PNG}")"

# Marketplace VSIX: rendered PNG at 512x512
rsvg-convert -w "${ICON_SIZE}" -h "${ICON_SIZE}" "${SOURCE_SVG}" -o "${PLUGIN_PNG}"

echo "Wrote ${PLUGIN_PNG}    ($(file "${PLUGIN_PNG}" | grep -oE '[0-9]+ x [0-9]+'))"

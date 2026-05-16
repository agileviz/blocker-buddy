#!/usr/bin/env bash
#
# build-marketplace-hero.sh — composite three Blocker Buddy widget screenshots
# into a single horizontal story-arc hero image for the ADO Marketplace
# listing.
#
# Source frames live in imagesrc/ (alongside icon.svg). Output goes to
# static/blocker-buddy-marketplace-hero.png, which is what the VSIX bundle
# ships and what overview.md references.
#
# Re-run this script every time any of the three source frames is recaptured
# (most commonly: slot 3 upgrading from day-1 single-spike to day-2-3 spread).
# Same script, same labels, same dimensions — the composite stays consistent
# across regenerations.
#
# Requires: ImageMagick 7+ (`brew install imagemagick`).
#
# Usage:
#   ./build-marketplace-hero.sh

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
IMAGESRC_DIR="${SCRIPT_DIR}/imagesrc"
OUTPUT_DIR="${SCRIPT_DIR}/static"
OUTPUT_FILE="${OUTPUT_DIR}/blocker-buddy-marketplace-hero.png"

FRAME_1="${IMAGESRC_DIR}/blocker-buddy-2-blocked-no-config-light.png"
FRAME_2="${IMAGESRC_DIR}/blocker-buddy-2-blocked-suggested-categories-light.png"
FRAME_3="${IMAGESRC_DIR}/blocker-buddy-in-use-light.png"

LABEL_1="Widget added to dashboard"
LABEL_2="Suggested categories added"
LABEL_3="Blocker patterns emerge"

# Visual parameters — tuned to match the support page caption styling so the
# marketplace hero and the support page triptych read as the same family.
LABEL_POINTSIZE="40"
LABEL_COLOR="#000000"
LABEL_PAD_TOP="90"        # vertical space above each frame for the label
LABEL_TEXT_OFFSET="30"    # baseline offset within the label band (visually balances cap-height ~30 in a 90px band)
GAP_BETWEEN_FRAMES="40"   # horizontal gap between frames
BACKGROUND_COLOR="white"

# Font discovery — modern Homebrew ImageMagick on macOS doesn't resolve font
# names like "Helvetica", but it accepts absolute paths. Try common system
# locations across macOS and Linux; first match wins.
FONT_CANDIDATES=(
    "/System/Library/Fonts/Helvetica.ttc"
    "/System/Library/Fonts/HelveticaNeue.ttc"
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    "/usr/share/fonts/TTF/DejaVuSans.ttf"
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
)
LABEL_FONT=""
for f in "${FONT_CANDIDATES[@]}"; do
    if [[ -f "${f}" ]]; then LABEL_FONT="${f}"; break; fi
done

# ── Pre-flight checks ────────────────────────────────────────────────────────

if ! command -v magick >/dev/null 2>&1; then
    echo "Error: ImageMagick (magick) not found." >&2
    echo "Install: brew install imagemagick" >&2
    exit 1
fi

if [[ -z "${LABEL_FONT}" ]]; then
    echo "Error: no usable font found in any of:" >&2
    printf "  %s\n" "${FONT_CANDIDATES[@]}" >&2
    echo "Add a path to your installed sans-serif font in FONT_CANDIDATES." >&2
    exit 1
fi

for f in "${FRAME_1}" "${FRAME_2}" "${FRAME_3}"; do
    if [[ ! -f "${f}" ]]; then
        echo "Error: missing source image: ${f}" >&2
        echo "" >&2
        echo "Capture all three light-mode frames into imagesrc/:" >&2
        echo "  1. blocker-buddy-2-blocked-no-config-light.png   (unconfigured state)" >&2
        echo "  2. blocker-buddy-2-blocked-suggested-categories-light.png   (after Add all 6)" >&2
        echo "  3. blocker-buddy-in-use-light.png   (mature populated state)" >&2
        exit 1
    fi
done

mkdir -p "${OUTPUT_DIR}"

# ── Build labeled frames into a temp dir ─────────────────────────────────────

TMP_DIR="$(mktemp -d)"
trap "rm -rf '${TMP_DIR}'" EXIT

label_frame() {
    local input="$1"
    local label="$2"
    local output="$3"
    # Bold via stroke-on-same-color: with path-based fonts (Helvetica.ttc et al.),
    # ImageMagick's -weight directive doesn't reliably select the bold sub-face.
    # Drawing the text with both a fill and a 1px stroke at the same color
    # thickens every glyph by ~1px in each direction — visually equivalent to
    # bold without needing to locate a separate bold font file.
    magick "${input}" \
        -background "${BACKGROUND_COLOR}" \
        -gravity north \
        -splice "0x${LABEL_PAD_TOP}" \
        -fill "${LABEL_COLOR}" \
        -stroke "${LABEL_COLOR}" \
        -strokewidth 1 \
        -font "${LABEL_FONT}" \
        -pointsize "${LABEL_POINTSIZE}" \
        -annotate "+0+${LABEL_TEXT_OFFSET}" "${label}" \
        "${output}"
}

label_frame "${FRAME_1}" "${LABEL_1}" "${TMP_DIR}/labeled-1.png"
label_frame "${FRAME_2}" "${LABEL_2}" "${TMP_DIR}/labeled-2.png"
label_frame "${FRAME_3}" "${LABEL_3}" "${TMP_DIR}/labeled-3.png"

# ── Concat horizontally with consistent gap ──────────────────────────────────
#
# Build a spacer image of the right height, then +append the three labeled
# frames with the spacer between them. Avoids `magick montage` because its
# default label-rendering behavior requires a font-renderable string even when
# we don't want labels (we already baked our own labels above each frame).

FRAME_HEIGHT=$(magick identify -format '%h' "${TMP_DIR}/labeled-1.png")
magick -size "${GAP_BETWEEN_FRAMES}x${FRAME_HEIGHT}" "xc:${BACKGROUND_COLOR}" "${TMP_DIR}/spacer.png"

magick \
    "${TMP_DIR}/labeled-1.png" \
    "${TMP_DIR}/spacer.png" \
    "${TMP_DIR}/labeled-2.png" \
    "${TMP_DIR}/spacer.png" \
    "${TMP_DIR}/labeled-3.png" \
    +append \
    "${OUTPUT_FILE}"

echo "Wrote ${OUTPUT_FILE}"
echo "Dimensions: $(magick identify -format '%wx%h' "${OUTPUT_FILE}")"

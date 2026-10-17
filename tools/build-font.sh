#!/usr/bin/env bash
set -euo pipefail

# Build TrueType (glyf) subset of Noto Sans TC for jsPDF (8.1 P1-b / D-48)
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHARSET="${ROOT_DIR}/tools/font-charset.txt"
VENDOR_DIR="${ROOT_DIR}/vendor"
SRC_FONT="${NOTO_FONT_SRC:-}"

if [[ -z "${SRC_FONT}" ]]; then
  for cand in \
    "/c/Windows/Fonts/NotoSansTC-VF.ttf" \
    "C:/Windows/Fonts/NotoSansTC-VF.ttf" \
    "${ROOT_DIR}/NotoSansTC[wght].ttf" \
    "/usr/share/fonts/truetype/noto/NotoSansTC[wght].ttf"; do
    if [[ -f "${cand}" ]]; then
      SRC_FONT="${cand}"
      break
    fi
  done
fi

if [[ -z "${SRC_FONT}" || ! -f "${SRC_FONT}" ]]; then
  echo "Error: NotoSansTC variable TTF not found. Set NOTO_FONT_SRC=/path/to/NotoSansTC[wght].ttf" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

for WGHT in 400 700; do
  STATIC_TTF="${TMP_DIR}/NotoSansTC-${WGHT}-static.ttf"
  SUBSET_TTF="${TMP_DIR}/NotoSansTC-${WGHT}.subset.ttf"

  python -m fontTools.varLib.instancer "${SRC_FONT}" "wght=${WGHT}" -o "${STATIC_TTF}"
  python -m fontTools.subset "${STATIC_TTF}" \
    --text-file="${CHARSET}" \
    --no-hinting \
    --desubroutinize \
    --layout-features="" \
    --output-file="${SUBSET_TTF}"

  # Verify: must have 'glyf', must NOT have 'CFF ', 'CFF2', 'fvar', and cmap must contain format 4
  python - "${SUBSET_TTF}" <<'PY'
import sys
from fontTools.ttLib import TTFont

path = sys.argv[1]
f = TTFont(path)
tables = set(f.keys())
assert "glyf" in tables, f"Missing glyf table in {path}"
for bad in ("CFF ", "CFF2", "fvar"):
    assert bad not in tables, f"Forbidden table {bad!r} found in {path}"
has_fmt4 = any(t.format == 4 for t in f["cmap"].tables)
assert has_fmt4, f"Missing cmap format 4 subtable in {path}"
print(f"Verified {path}: tables={sorted(tables)}, cmap_fmt4={has_fmt4}")
PY

  HASH="$(python - "${SUBSET_TTF}" <<'PY'
import hashlib, sys
data = open(sys.argv[1], "rb").read()
print(hashlib.sha256(data).hexdigest()[:8])
PY
)"

  rm -f "${VENDOR_DIR}/NotoSansTC-${WGHT}."*".ttf"
  OUT_FILE="${VENDOR_DIR}/NotoSansTC-${WGHT}.${HASH}.ttf"
  cp "${SUBSET_TTF}" "${OUT_FILE}"
  echo "Built ${OUT_FILE} ($(wc -c < "${OUT_FILE}") bytes)"
done

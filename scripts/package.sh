#!/usr/bin/env bash
# Builds the release zip containing only the files the extension needs, plus a
# SHA-256 checksum file so people can confirm their download is the official one.
#
#   ./scripts/package.sh   -> dist/paper-library-v<version>.zip
#                             dist/paper-library-v<version>.zip.sha256
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
NAME="paper-library-v${VERSION}"
OUT="dist/${NAME}.zip"

FILES=(manifest.json background.js content.js content.css
       viewer.html viewer.css viewer.js library.html library.css library.js
       js icons lib LICENSE)

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/paper-library" dist
cp -r "${FILES[@]}" "$STAGE/paper-library/"
cp docs/PRIVACY.md docs/SETUP.md "$STAGE/paper-library/"
rm -f "$OUT"
# One top-level folder, so unzipping doesn't scatter files. -X drops extra
# file attributes so the zip only depends on the file contents and names.
(cd "$STAGE" && zip -qrX "$OLDPWD/$OUT" paper-library)
(cd dist && sha256sum "${NAME}.zip" > "${NAME}.zip.sha256")

echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
cat "dist/${NAME}.zip.sha256"

#!/usr/bin/env bash
# Build standalone `legalese` binaries for the release matrix using Bun's
# --compile cross-compilation. Output + SHA256SUMS go to $1 (default dist-bin/).
#
#   ./scripts/build-binaries.sh [outdir]
#
# Requires: bun (https://bun.sh). Run `npm install` first for dependencies.
set -euo pipefail

OUT="${1:-dist-bin}"
ENTRY="src/index.ts"

rm -rf "$OUT"
mkdir -p "$OUT"

# bun target → published asset name (matched by install.sh's os-arch detection)
targets=(
  "bun-darwin-arm64:legalese-darwin-arm64"
  "bun-darwin-x64:legalese-darwin-x64"
  "bun-linux-x64:legalese-linux-x64"
  "bun-linux-arm64:legalese-linux-arm64"
)

for entry in "${targets[@]}"; do
  target="${entry%%:*}"
  name="${entry##*:}"
  echo "→ building $name ($target)"
  bun build "$ENTRY" --compile --minify --target="$target" --outfile "$OUT/$name"
done

# Checksums for install.sh verification.
( cd "$OUT"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum legalese-* > SHA256SUMS
  else
    shasum -a 256 legalese-* > SHA256SUMS
  fi )

echo "built binaries → $OUT"
ls -la "$OUT"

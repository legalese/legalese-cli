#!/bin/sh
# legalese CLI installer.  Usage:
#   curl -fsSL https://legalese.cloud/cli/install.sh | sh
#
# Downloads the right prebuilt binary for your OS/arch, verifies its checksum,
# and installs it as `legalese`. Override the source/channel/dir with env vars:
#   LEGALESE_CLI_BASE     (default https://legalese.cloud/cli)
#   LEGALESE_CLI_CHANNEL  (default latest)
#   LEGALESE_CLI_BINDIR   (default /usr/local/bin, else ~/.local/bin)
set -eu

BASE="${LEGALESE_CLI_BASE:-https://legalese.cloud/cli}"
CHANNEL="${LEGALESE_CLI_CHANNEL:-latest}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) echo "legalese: unsupported architecture: $arch" >&2; exit 1 ;;
esac
case "$os" in
  darwin | linux) ;;
  *) echo "legalese: unsupported OS: $os (try npm i -g @legalese/cli)" >&2; exit 1 ;;
esac

asset="legalese-${os}-${arch}"
url="${BASE}/${CHANNEL}/${asset}"

# Pick an install dir.
if [ -n "${LEGALESE_CLI_BINDIR:-}" ]; then
  bindir="$LEGALESE_CLI_BINDIR"
elif [ -w /usr/local/bin ] || [ "$(id -u)" = "0" ]; then
  bindir="/usr/local/bin"
else
  bindir="${HOME}/.local/bin"
fi
mkdir -p "$bindir" 2>/dev/null || true

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
echo "legalese: downloading ${url}" >&2
curl -fSL --proto '=https' "$url" -o "$tmp"

# Best-effort checksum verification.
sums="$(curl -fsSL "${BASE}/${CHANNEL}/SHA256SUMS" 2>/dev/null || true)"
if [ -n "$sums" ]; then
  expected="$(printf '%s\n' "$sums" | awk -v a="$asset" '$2==a || $2=="*"a {print $1}' | head -1)"
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$tmp" | awk '{print $1}')"
    else
      actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
    fi
    if [ "$expected" != "$actual" ]; then
      echo "legalese: checksum mismatch for $asset — aborting" >&2
      exit 1
    fi
  fi
fi

chmod +x "$tmp"
dest="${bindir}/legalese"
if mv "$tmp" "$dest" 2>/dev/null; then
  :
else
  echo "legalese: ${bindir} is not writable, retrying with sudo" >&2
  sudo mv "$tmp" "$dest"
  sudo chmod +x "$dest"
fi
trap - EXIT

echo "legalese: installed → ${dest}" >&2
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "legalese: add ${bindir} to your PATH to run 'legalese'." >&2 ;;
esac
"$dest" --version >&2 2>/dev/null || true

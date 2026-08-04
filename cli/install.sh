#!/usr/bin/env bash
# Install stellar-agent-pay so the stellar CLI can dispatch `stellar agent-pay`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
npm install --omit=dev --prefix "$here" >/dev/null 2>&1 || npm install --prefix "$here"
target="${1:-$HOME/.local/bin}"
mkdir -p "$target"
ln -sf "$here/bin/stellar-agent-pay.mjs" "$target/stellar-agent-pay"
chmod +x "$here/bin/stellar-agent-pay.mjs"
echo "installed: $target/stellar-agent-pay"
echo "ensure $target is on your PATH, then: stellar agent-pay --help"

#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-24.12.0}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/codex-gateway-node}"

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64 | arm64) NODE_ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
URL="https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$INSTALL_DIR"
curl -fsSL "$URL" -o "$TMP_DIR/$TARBALL"
tar -xJf "$TMP_DIR/$TARBALL" -C "$INSTALL_DIR" --strip-components=1

export PATH="$INSTALL_DIR/bin:$PATH"

"$INSTALL_DIR/bin/node" --version
"$INSTALL_DIR/bin/npm" --version

cat <<EOF

User-local Node installed at:
  $INSTALL_DIR

For this shell:
  export PATH="$INSTALL_DIR/bin:\$PATH"
EOF

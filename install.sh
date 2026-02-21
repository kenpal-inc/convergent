#!/usr/bin/env bash
set -euo pipefail

REPO="kenpal-inc/convergent"
INSTALL_DIR="${HOME}/.convergent/app"
BIN_DIR="${HOME}/.local/bin"

info() { printf '\033[1;34m%s\033[0m\n' "$*"; }
error() { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

# --- Pre-flight checks ---

if ! command -v bun &>/dev/null; then
  error "bun is required but not found. Install it first: https://bun.sh/"
fi

if ! command -v claude &>/dev/null; then
  echo "Warning: claude CLI not found. convergent requires it at runtime."
  echo "  Install: https://docs.anthropic.com/en/docs/claude-code"
  echo ""
fi

if ! command -v curl &>/dev/null; then
  error "curl is required but not found."
fi

if ! command -v tar &>/dev/null; then
  error "tar is required but not found."
fi

# --- Resolve latest version ---

info "Fetching latest release..."

LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')

if [ -z "$LATEST_TAG" ]; then
  error "Could not determine the latest release. Check https://github.com/${REPO}/releases"
fi

info "Latest version: ${LATEST_TAG}"

# --- Download and extract ---

TARBALL_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/convergent-${LATEST_TAG}.tar.gz"

info "Downloading ${TARBALL_URL}..."

rm -rf "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"

curl -fsSL "$TARBALL_URL" | tar xz -C "${INSTALL_DIR}" --strip-components=1

# --- Create wrapper script ---

mkdir -p "${BIN_DIR}"

cat > "${BIN_DIR}/convergent" <<'WRAPPER'
#!/usr/bin/env bash
exec bun run "${HOME}/.convergent/app/convergent.ts" "$@"
WRAPPER

chmod +x "${BIN_DIR}/convergent"

# --- Done ---

info ""
info "convergent ${LATEST_TAG} installed successfully!"
info ""
info "  Location: ${INSTALL_DIR}"
info "  Binary:   ${BIN_DIR}/convergent"
info ""

# Check if BIN_DIR is in PATH
if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
  echo "Add ${BIN_DIR} to your PATH if it's not already:"
  echo ""
  echo "  export PATH=\"${BIN_DIR}:\$PATH\""
  echo ""
fi

info "Get started:"
info ""
info "  convergent --help"
info ""

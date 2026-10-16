#!/bin/sh
set -eu

REPO="${CORAMI_REPO:-tapeo/corami}"
VERSION="${CORAMI_VERSION:-latest}"
PREFIX="${CORAMI_PREFIX:-$HOME/.corami/bin}"

log() {
  printf '%s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

detect_os() {
  case "$(uname -s)" in
    Linux*) printf 'linux' ;;
    Darwin*) printf 'darwin' ;;
    *) die "unsupported operating system: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

release_url() {
  if [ -n "${CORAMI_INSTALL_BASE:-}" ]; then
    printf '%s' "$CORAMI_INSTALL_BASE"
    return
  fi

  if [ "$VERSION" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download' "$REPO"
    return
  fi

  printf 'https://github.com/%s/releases/download/%s' "$REPO" "$VERSION"
}

main() {
  command -v curl >/dev/null 2>&1 || die "curl is required"

  os="$(detect_os)"
  arch="$(detect_arch)"
  base="$(release_url)"
  asset="corami-${os}-${arch}"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  log "downloading $asset"
  curl -fsSL "$base/$asset" -o "$tmp/$asset" || die "download failed: $base/$asset"

  log "verifying the sha256 sum"
  if curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" 2>/dev/null; then
    expected="$(grep " $asset\$" "$tmp/checksums.txt" | awk '{print $1}')"

    if [ -n "$expected" ]; then
      actual="$(sha256_of "$tmp/$asset")"

      if [ "$expected" != "$actual" ]; then
        die "sha256 mismatch for $asset"
      fi
    else
      log "warning: $asset is not in checksums.txt"
    fi
  else
    log "warning: checksums.txt not available, skipping the check"
  fi

  mkdir -p "$PREFIX"
  install -m 0755 "$tmp/$asset" "$PREFIX/corami"
  log "installed to $PREFIX/corami"
  add_to_path

  if [ "${CORAMI_SKIP_SETUP:-}" = "1" ]; then
    log "setup skipped (CORAMI_SKIP_SETUP=1)"
    return
  fi

  case "${1:-}" in
    server|client|"") ;;
    *) die "unknown role: $1 (use server or client)" ;;
  esac

  # With `curl | sh` stdin is the script itself: the setup reads its answers
  # from the terminal. Without a role it asks which one this machine takes.
  if has_terminal; then
    "$PREFIX/corami" setup "$@" < /dev/tty
    return
  fi

  if [ "${1:-}" = "client" ] && [ "$#" -gt 1 ]; then
    "$PREFIX/corami" setup "$@"
    return
  fi

  log ""
  log "no terminal available, next step:"
  log "  on the Linux server:  corami setup server --owner <your-tailscale-login>"
  log "  on a client:          corami setup client <server>"
}

has_terminal() {
  (: < /dev/tty) 2>/dev/null
}

# Puts the install folder in the PATH of new shells, once. The line goes in the
# profile of the login shell; with another shell it says what to add.
add_to_path() {
  case ":$PATH:" in
    *":$PREFIX:"*) return ;;
  esac

  case "$(basename "${SHELL:-sh}")" in
    zsh) profile="$HOME/.zshrc" ;;
    bash)
      if [ "$(uname -s)" = "Darwin" ]; then
        profile="$HOME/.bash_profile"
      else
        profile="$HOME/.bashrc"
      fi
      ;;
    *)
      log "add $PREFIX to your PATH to use corami without the full path"
      return
      ;;
  esac

  line="export PATH=\"$PREFIX:\$PATH\""

  if [ -f "$profile" ] && grep -qF "$line" "$profile"; then
    return
  fi

  printf '\n# corami\n%s\n' "$line" >> "$profile"
  log "added $PREFIX to the PATH in $profile: open a new terminal to use corami"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi

  shasum -a 256 "$1" | awk '{print $1}'
}

main "$@"

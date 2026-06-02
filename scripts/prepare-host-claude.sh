#!/usr/bin/env sh
set -eu

if ! command -v claude >/dev/null 2>&1; then
  echo "claude command not found on host PATH." >&2
  exit 1
fi

CLAUDE_BIN="$(command -v claude)"

resolve_link() {
  target="$1"
  while [ -L "$target" ]; do
    link="$(readlink "$target")"
    case "$link" in
      /*) target="$link" ;;
      *) target="$(cd "$(dirname "$target")" && pwd)/$link" ;;
    esac
  done
  cd "$(dirname "$target")" && printf '%s/%s\n' "$(pwd)" "$(basename "$target")"
}

CLAUDE_REAL="$(resolve_link "$CLAUDE_BIN")"
CLAUDE_DIR="$(dirname "$CLAUDE_REAL")"

mkdir -p .host-claude
rm -rf .host-claude/claude-code
cp -R "$CLAUDE_DIR" .host-claude/claude-code
chmod +x .host-claude/claude-code/cli.js

if [ ! -d "$HOME/.claude" ]; then
  echo "Warning: $HOME/.claude was not found. Run 'claude' on the host and finish login first." >&2
fi

echo "Prepared host Claude Code CLI from:"
echo "  $CLAUDE_REAL"
echo
echo "Next:"
echo "  docker compose -f docker-compose.yml -f docker-compose.host-claude.yml up -d --build"

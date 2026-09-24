#!/bin/bash
# Gives this repository the design toolkit (JustAdev742/codespace: 70 skills, the design-review
# subagent, /design-plan, /design-review and four MCP servers) in every Claude Code session, on
# any branch, on the web and on your own computer alike. The toolkit is installed at user level
# (~/.claude), so nothing lands in this repository's working tree. Runs synchronously, so the
# skills exist before the first turn; the clone is cached, so after the first run it is quick.
TOOLKIT="${TOOLKIT_REPO:-https://github.com/JustAdev742/codespace}"
DIR="${TMPDIR:-/tmp}/claude-toolkit"

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull -q --ff-only 2>/dev/null || true       # offline: use what we have
else
  git clone -q --depth 1 "$TOOLKIT" "$DIR" 2>/dev/null || { echo "toolkit: could not fetch $TOOLKIT, continuing without it"; exit 0; }
fi
bash "$DIR/scripts/install-toolkit.sh" || echo "toolkit: install failed, continuing without it"
exit 0   # never hold a session up over the toolkit

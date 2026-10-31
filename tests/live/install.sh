#!/usr/bin/env bash
set -euo pipefail
umask 077
tool_dir="${RUNNER_TEMP:?}/kinmesh-tools"
mkdir -p "$tool_dir"
archive="$tool_dir/t3.tar.gz"
curl -fsSL --retry 3 https://github.com/pingdotgg/t3code/releases/download/v0.1.5/t3-0.1.5-linux-x64.tar.gz -o "$archive"
printf '%s  %s\n' '21d50dcc9c634221b11b58d6a94350d2c6ee36905737b054b11fa4eba295a98b' "$archive" | sha256sum --check --status
tar -xzf "$archive" -C "$tool_dir"
npm install --prefix "$tool_dir/codex" --no-audit --no-fund @openai/codex@0.166.0
curl -fsSL --retry 3 https://x.ai/cli/install.sh -o "$tool_dir/install-grok.sh"
bash "$tool_dir/install-grok.sh" 1.0.70
t3_binary="$(find "$tool_dir" -maxdepth 3 -type f -name t3 -print -quit)"
test -n "$t3_binary"
"$t3_binary" --version
"$tool_dir/codex/node_modules/.bin/codex" --version
"$HOME/.grok/bin/grok" --version
{
  printf 'KINMESH_T3_BINARY=%s\n' "$t3_binary"
  printf 'KINMESH_CODEX_BINARY=%s\n' "$tool_dir/codex/node_modules/.bin/codex"
  printf 'KINMESH_GROK_BINARY=%s\n' "$HOME/.grok/bin/grok"
} >> "${GITHUB_ENV:?}"

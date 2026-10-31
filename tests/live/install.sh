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
curl -fsSL --retry 3 https://x.ai/cli/grok-1.0.70-linux-x86_64 -o "$tool_dir/grok"
printf '%s  %s\n' '22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9' "$tool_dir/grok" | sha256sum --check --status
chmod 700 "$tool_dir/grok"
t3_binary="$(find "$tool_dir" -maxdepth 3 -type f -name t3 -print -quit)"
test -n "$t3_binary"
test "$("$t3_binary" --version)" = "t3 v0.1.5"
test "$("$tool_dir/codex/node_modules/.bin/codex" --version)" = "codex-cli 0.166.0"
"$tool_dir/grok" --version | grep -Eq '^grok 1\.0\.70( |$)'
{
  printf 'KINMESH_T3_BINARY=%s\n' "$t3_binary"
  printf 'KINMESH_CODEX_BINARY=%s\n' "$tool_dir/codex/node_modules/.bin/codex"
  printf 'KINMESH_GROK_BINARY=%s\n' "$tool_dir/grok"
} >> "${GITHUB_ENV:?}"

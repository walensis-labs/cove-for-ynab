#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm -F @walensis/mcp-for-ynab-core build
MCPB_BUNDLE=1 pnpm -F @walensis/mcp-for-ynab build

# Stage only what the extension needs: a self-contained bundle + manifest.
# Never pack node_modules — pnpm's symlinked layout breaks transitive
# resolution inside the archive (zod-to-json-schema via the MCP SDK).
STAGE=$(mktemp -d)
CHECK=$(mktemp -d)
trap 'rm -rf "$STAGE" "$CHECK"' EXIT
mkdir -p "$STAGE/dist"
cp apps/mcp/dist-mcpb/main.js "$STAGE/dist/main.js"
cp apps/mcp/manifest.json "$STAGE/manifest.json"

npx -y @anthropic-ai/mcpb pack "$STAGE" mcp-for-ynab.mcpb

# Self-test: the packed bundle must boot standalone (no node_modules) and
# reach the ready line on stderr; a module-resolution failure dies before it.
unzip -q mcp-for-ynab.mcpb -d "$CHECK"
if YNAB_ACCESS_TOKEN=selftest node "$CHECK/dist/main.js" </dev/null 2>&1 | grep -q 'mcp-for-ynab ready'; then
  echo "self-test OK: bundle boots standalone"
else
  echo "SELF-TEST FAILED: packed bundle did not reach ready line" >&2
  exit 1
fi

echo "built mcp-for-ynab.mcpb"

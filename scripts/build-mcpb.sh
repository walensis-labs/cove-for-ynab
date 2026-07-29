#!/usr/bin/env bash
set -euo pipefail
pnpm -F @walensis/mcp-for-ynab-core build
pnpm -F @walensis/mcp-for-ynab build
cd apps/mcp
npx -y @anthropic-ai/mcpb pack . ../../mcp-for-ynab.mcpb
echo "built mcp-for-ynab.mcpb"

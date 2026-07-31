---
"@walensis/mcp-for-ynab": patch
---

Retire the `.mcpb` Claude Desktop extension — one fewer artifact to build, version, and publish. There are now exactly two install paths: local (`npx -y @walensis/mcp-for-ynab`, via `claude mcp add` or the Claude Desktop JSON config) or remote (one URL + token, self-hosted today via `apps/worker`, hosted later). See the README for the full install/tier breakdown.

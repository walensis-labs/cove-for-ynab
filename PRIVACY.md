# Privacy

`mcp-for-ynab` is a local MCP server. There is no backend service run by this
project — it is a thin process that runs on your own machine and talks
directly to YNAB's API.

- **Data flow**: all requests go directly between your machine and
  `api.ynab.com`, over HTTPS, using your personal access token. Nothing
  passes through any server operated by this project.
- **No telemetry**: this server does not collect, log, or transmit usage
  data, analytics, or crash reports anywhere.
- **No third-party services**: the only network calls this server makes are
  to `api.ynab.com`.
- **Your token stays in your environment**: the access token is read from
  the `YNAB_ACCESS_TOKEN` (or `YNAB_ACCESS_TOKEN_FILE`) environment variable
  you configure. It is held in memory for the life of the process and is
  never written to disk, logged, or sent anywhere other than
  `api.ynab.com`.
- **Undo journal**: to support the `undo_last` tool, a local log of the
  inverse of each write is kept at `~/.cove/undo.json` on your own
  machine. It contains transaction/category/payee data needed to reverse a
  change (capped at the 50 most recent writes) — nothing is sent anywhere.
  You can inspect, back up, or delete this file at any time; deleting it
  simply clears undo history.

If you have questions about this project's privacy practices, please open an
issue on the [GitHub repository](https://github.com/walensis-labs/cove-for-ynab).

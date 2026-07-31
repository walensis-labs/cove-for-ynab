---
"@walensis/cove-core": patch
---

Bind the global fetch in YnabClient. Stored as a property and invoked as a method, an unbound global `fetch` throws "Illegal invocation" under workerd — the client worked on Node but failed in any Cloudflare Worker deploy.

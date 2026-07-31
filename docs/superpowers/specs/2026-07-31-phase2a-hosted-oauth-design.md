# Phase 2a: Cove Cloud — multi-tenant OAuth + free hosted tier

Status: Approved (brainstormed with AJ 2026-07-31)
Parent: `docs/product-model.md` (Cove vs Cove Watch), `docs/superpowers/specs/2026-07-30-balancing-suite-brief.md` §7 Phase 2
Implementation repo: **private** `walensis-labs/cove-cloud` (this spec lives in the OSS repo as the public record of intent; no proprietary detail here)

## Goal

Stand up the hosted free tier: any YNAB user connects Cove to claude.ai (or any MCP client)
via OAuth — no personal access token, no setup — and gets the read-only toolset. This is the
acquisition surface and the prerequisite for Cove Watch.

## Decisions (settled)

1. **Two workers, not one.** AJ's single-tenant `cove` worker keeps running untouched while the
   multi-tenant service is built beside it. When it works, **AJ becomes tenant #1** (dogfood) and
   the personal worker retires.
2. **The worker plays both OAuth roles**: an OAuth 2.1 *authorization server* to MCP clients (via
   `@cloudflare/workers-oauth-provider` — `/authorize`, `/token`, `/register`) and an OAuth
   *client* to YNAB. Same broker pattern as `almostjacked/cloud`'s hevy-coach worker, but with an
   upstream OAuth dance where hevy has a paste-key form. Reuse hevy's HMAC-signed-state helper for
   the browser round trip.
3. **YNAB tokens live in D1, not in grant props.** Props carry only `{ userId }`. Rationale that
   settles it: Cove Watch's cron runs with no access token and no props, so tokens must be
   retrievable by user id. Building this way now avoids a migration in 2b.
4. **Refresh on use, never on a schedule.** YNAB access tokens expire in 2h; refresh inline when a
   request finds one stale, then write back. This is what keeps the free tier free to operate — a
   scheduled refresh would silently turn it into a Product (see product-model.md's rule).
5. **Free tier requests YNAB's `read-only` scope.** Falls out of the product model: free is "Ask"
   and "See". Writes are where the undo journal matters and the hosted path has none. Gives the
   free tier a strong line — *the hosted free tier cannot change your budget*. Acting stays local
   (undo journal on your machine) or moves to Cove Watch, where a D1-backed journal is worth
   building. Month-close sessions still plan fully; they just can't apply moves.
6. **Reuse the stateless Hono `/mcp` handler** as OAuthProvider's `apiHandler` (read `userId` from
   props, build a `Ynab` per request) rather than Cloudflare's DO-backed `McpAgent`. Keeps the OSS
   and hosted paths on one code path, which keeps the open packages honest.

## Data model (D1)

- `users` — our id (PK), `ynab_user_id` (unique), `created_at`, `email` (null until billing)
- `ynab_tokens` — `user_id` (PK/FK), access token, refresh token, `expires_at`, `updated_at`.
  **Encrypted at rest with a worker-held key** (AES-GCM); Cloudflare's storage-level encryption
  alone is a weak story for financial credentials.
- `ledger_records` — gains `user_id` + index; otherwise the schema the OSS worker already uses.

## Routes

`/authorize`, `/token`, `/register` (OAuthProvider) · `/ynab/callback` (upstream redirect target) ·
`/mcp` (OAuth-protected, the existing handler) · `/health`.

## Security posture

Tokens encrypted at rest; never logged (the core client already redacts them from errors); signed
state on the browser round trip so a POST can't be replayed with a forged `redirect_uri`;
read-only upstream scope for free-tier grants.

## Out of scope (2b)

Billing, entitlements, cron monitoring, email delivery, narratives, D1-backed undo journal,
write-scope grants.

## AJ's manual steps

1. Register the YNAB OAuth application (self-serve; starts in **restricted mode — 25 non-owner
   users**).
2. **Submit for review as soon as 2a works.** It's the same submission as the **Works-with-YNAB
   listing** (unclaimed by anyone in the ecosystem as of the 2026-07 research) and takes 2–4 weeks,
   so it should be in flight while 2b is built, not after.

## Success criteria

A YNAB user other than AJ connects via claude.ai's custom-connector OAuth flow, sees the toolset,
asks a budget question, and never handles a token. AJ's own account works as tenant #1. No
scheduled work exists anywhere in the deployment.

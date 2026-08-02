# TODO — Fix Instagram DM replies (webhook not replying)

## Root cause
`src/app/api/instagram/webhook/route.ts` called `.catch()` on the Supabase query
builder (thenable, but no `.catch` method) in `handleInstagramMessagingEvent`,
which threw `TypeError` on every incoming DM — the crash happened before the
product lookup / `sendInstagramDm` was ever reached, so the app never replied.

## Steps
- [x] 1. Import `after` from `next/server` in the Instagram webhook route
- [x] 2. Add `export const maxDuration = 60` (Vercel headroom for DB + Meta calls)
- [x] 3. Replace invalid `.catch(() => {})` on the `last_webhook_at` update with a proper try/catch
- [x] 4. Replace the floating `processInstagramWebhook(body).catch(...)` with `after(async () => { ... })` so background processing reliably runs on Vercel
- [x] 5. Add per-event try/catch in the processing loop + wrap each `sendInstagramDm` call in its own try/catch with error logging (error isolation)
- [x] 6. Typecheck (`npm run typecheck`) — no Instagram-related errors found


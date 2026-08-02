# TODO — Fix Instagram DM replies (webhook not replying)

## Root cause
`src/app/api/instagram/webhook/route.ts` called `.catch()` on the Supabase query
builder (thenable, but no `.catch` method) in `handleInstagramMessagingEvent`,
which threw `TypeError` on every incoming DM — the crash happened before the
product lookup / `sendInstagramDm` was ever reached, so the app never replied.

Additionally, the Instagram webhook signed payloads with `META_APP_SECRET`, but
Instagram webhooks can be subscribed under a *different* Meta App than
WhatsApp, in which case Meta signs with that App's secret — causing every POST
to be rejected as "Invalid signature".

## Steps
- [x] 1. Import `after` from `next/server` in the Instagram webhook route
- [x] 2. Add `export const maxDuration = 60` (Vercel headroom for DB + Meta calls)
- [x] 3. Replace invalid `.catch(() => {})` on the `last_webhook_at` update with a proper try/catch
- [x] 4. Replace the floating `processInstagramWebhook(body).catch(...)` with `after(async () => { ... })` so background processing reliably runs on Vercel
- [x] 5. Add per-event try/catch in the processing loop + wrap each `sendInstagramDm` call in its own try/catch with error logging (error isolation)
- [x] 6. Support `INSTAGRAM_APP_SECRET` (falling back to `META_APP_SECRET`) for IG webhook signature verification
- [x] 7. Typecheck (`npm run typecheck`) passes
- [x] 8. Committed + pushed to `main` (deploy → solusio.vercel.app)

## Deployment notes
On Vercel (solusio.vercel.app), ensure the following env vars are set:
- `INSTAGRAM_APP_SECRET` — the App Secret of the Meta App the Instagram webhook
  is subscribed under (if it differs from the WhatsApp App, also keep
  `META_APP_SECRET` for the WhatsApp webhook)
- `ENCRYPTION_KEY` — must match the key used when the Instagram config was saved
- `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`

Webhook callbacks to register:
- `https://solusio.vercel.app/api/whatsapp/webhook`
- `https://solusio.vercel.app/api/instagram/webhook`
</content>


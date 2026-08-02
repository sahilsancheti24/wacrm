# Instagram DM Integration — Implementation Plan

## Files to Create/Modify
- [x] `supabase/migrations/040_instagram_config.sql` — New table for IG credentials
- [x] `src/lib/instagram/client.ts` — Graph API client for Instagram (send DMs, verify)
- [x] `src/lib/instagram/index.ts` — Exports
- [x] `src/app/api/instagram/webhook/route.ts` — GET (verify) + POST (receive DMs, respond with wa.me link)
- [x] `src/app/api/instagram/config/route.ts` — GET/POST/DELETE for IG config management
- [x] `src/components/settings/instagram-config.tsx` — Instagram settings form
- [x] `src/app/(dashboard)/settings/page.tsx` — Add Instagram tab
- [x] `messages/en.json` — Add Instagram settings translations
- [x] `src/components/settings/instagram-config.tsx` — Update to use i18n `t()` calls

## Follow-up (current task)
- [x] Apply migration `040` to remote Supabase (`instagram_config` table now live)
- [x] Fix `DROP POLICY` syntax error in `040_instagram_config.sql` and push to `origin/main` (`17f285b`)
- [x] Verify webhook route works (`{"error":"Verification token mismatch"}` → 403, table exists)
- [x] Verify TypeScript typecheck passes (`tsc --noEmit` exit 0)
- [x] Verify dev server serves the app (`/login` → 200, `/` → 307 to `/login`)
- [ ] Run i18n parity test (`npx vitest run src/i18n/messages.test.ts`) — `ko.json` parity fix deferred
- [ ] Deploy to Vercel (`vercel-deploy` branch exists) so the public webhook callback URL is reachable by Meta


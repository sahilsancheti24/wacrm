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
- [ ] Run i18n parity test (`npx vitest run src/i18n/messages.test.ts`) to confirm app state
- [ ] Start dev server (`npm run dev`) and verify the app is running with Instagram integration live


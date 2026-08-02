#!/usr/bin/env node
/**
 * Simulate an Instagram DM webhook POST so you can test the IG module
 * without waiting for a real Meta delivery.
 *
 * It:
 *   1. Loads .env.local (so META_APP_SECRET + the service-role creds resolve)
 *   2. Builds a fake Instagram "messaging" payload
 *   3. HMAC-signs the raw body with META_APP_SECRET (same as Meta does)
 *   4. POSTs to the webhook URL
 *
 * Usage:
 *   node scripts/test-instagram-webhook.mjs                       # localhost:3000
 *   node scripts/test-instagram-webhook.mjs https://solusio.vercel.app
 *   IG_USER_ID=<igBusinessAccountId> node scripts/test-instagram-webhook.mjs
 *   MESSAGE="ORDER" node scripts/test-instagram-webhook.mjs       # trigger keyword
 *
 * Notes:
 *   - The `entry.id` (IG Business Account id) must match the `ig_user_id`
 *     saved in the instagram_config row for the handler to find a config.
 *   - If the config + a matching active product exist, the route will call
 *     Meta's Graph API to actually send a DM reply (using the stored token),
 *     so this is a true end-to-end test of the send path.
 *   - The GET (verification) path is exercised separately by curl — see the
 *     README section in the repo or the guide.
 */
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '..', '.env.local');

// Load .env.local (simple parser — no deps).
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const baseUrl = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const igUserId =
  process.env.IG_USER_ID || process.argv[3] || '17841400000000000';
const message = process.env.MESSAGE || process.argv[4] || 'HELLO';
const secret = process.env.META_APP_SECRET;

if (!secret) {
  console.error(
    '✗ META_APP_SECRET is not set (checked .env.local and environment).',
  );
  process.exit(1);
}

const body = JSON.stringify({
  object: 'instagram',
  entry: [
    {
      id: igUserId,
      time: Date.now(),
      messaging: [
        {
          sender: { id: 'TEST_SENDER_ID_123' },
          recipient: { id: igUserId },
          timestamp: Date.now(),
          message: {
            mid: `test-mid-${Date.now()}`,
            text: message,
          },
        },
      ],
    },
  ],
});

const signature = `sha256=${createHmac('sha256', secret)
  .update(body)
  .digest('hex')}`;

console.log(`POST ${baseUrl}/api/instagram/webhook`);
console.log(`  ig_user_id : ${igUserId}`);
console.log(`  message    : "${message}"`);
console.log(`  signature  : ${signature.slice(0, 24)}…`);

const res = await fetch(`${baseUrl}/api/instagram/webhook`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-hub-signature-256': signature,
  },
  body,
});

console.log(`  status     : ${res.status}`);
console.log(`  body       : ${await res.text()}`);


import crypto from 'node:crypto';
import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { sendInstagramDm } from '@/lib/instagram/client';
import type {
  InstagramWebhookPayload,
  InstagramWebhookEntry,
  InstagramMessagingEntry,
  SendInstagramDmArgs,
} from '@/lib/instagram';

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing fans out to DB lookups + Meta API send calls, so
// give it headroom beyond the platform default (Vercel clamps this to
// the plan's ceiling). Tune as needed.
export const maxDuration = 60;

// ============================================================
// Instagram DM Webhook
//
// GET  â€” Webhook verification (hub.challenge)
// POST â€” Receive incoming DMs, detect keywords, respond with wa.me link
// ============================================================

// Lazy-initialized service-role client for DB lookups
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

/**
 * GET â€” Instagram webhook verification.
 *
 * Meta sends a GET request with:
 *   ?hub.mode=subscribe&hub.challenge=<challenge>&hub.verify_token=<token>
 *
 * We look up the stored verify_token for each instagram_config and
 * respond with the challenge if there's a match.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('hub.mode');
    const challenge = searchParams.get('hub.challenge');
    const verifyToken = searchParams.get('hub.verify_token');

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      );
    }

    // Fetch all instagram configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('instagram_config')
      .select('id, verify_token');

    if (configError || !configs) {
      console.error('[instagram/webhook] Error fetching configs:', configError);
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      );
    }

    // Check if any config's verify_token matches
    for (const config of configs) {
      if (!config.verify_token) continue;
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          // Return challenge as plain text
          return new Response(challenge, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
      } catch {
        // Malformed / wrong-key token row â€” skip it
      }
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    );
  } catch (error) {
    console.error('[instagram/webhook] GET verification error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * Verify the Instagram webhook HMAC signature.
 *
 * Instagram webhooks can be subscribed under a Meta app that is
 * different from the WhatsApp Cloud API app â€” in that case Meta signs
 * Instagram payloads with THAT app's secret, not the `META_APP_SECRET`
 * used by the WhatsApp webhook. We therefore prefer a dedicated
 * `INSTAGRAM_APP_SECRET` when set, and fall back to `META_APP_SECRET`.
 *
 * Logs exactly what was tried so a mismatch is diagnosable in Vercel
 * logs instead of a bare "Invalid signature".
 */
function verifyInstagramWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const candidates = [
    { name: 'INSTAGRAM_APP_SECRET', value: process.env.INSTAGRAM_APP_SECRET },
    { name: 'META_APP_SECRET', value: process.env.META_APP_SECRET },
  ];

  for (const { name, value } of candidates) {
    if (!value) continue;
    if (verifyMetaWebhookSignatureWithSecret(rawBody, signatureHeader, value)) {
      return true;
    }
  }

  // Log the failure reason for Vercel logs.
  const missing = candidates
    .filter((c) => !c.value)
    .map((c) => c.name)
    .join(', ');
  if (missing) {
    console.warn(
      `[instagram/webhook] Invalid signature â€” no matching secret. Missing env: ${missing || 'none'}. ` +
        'If Instagram is subscribed under a different Meta App than WhatsApp, set INSTAGRAM_APP_SECRET to that app\'s secret.'
    );
  } else {
    console.warn(
      '[instagram/webhook] Invalid signature â€” signed body does not match INSTAGRAM_APP_SECRET or META_APP_SECRET. ' +
        'Confirm the webhook is subscribed under the same Meta App whose secret is configured.'
    );
  }
  return false;
}

function verifyMetaWebhookSignatureWithSecret(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  try {
    const expected =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * POST â€” Receive Instagram DM events.
 *
 * When someone DMs the Instagram Business Account, Meta sends a POST
 * with the message payload. We:
 *   1. Verify the HMAC signature
 *   2. Find the matching Instagram config
 *   3. Check if the message text matches a product trigger_keyword
 *   4. Reply with a WhatsApp deep link (wa.me)
 */
export async function POST(request: Request) {
  // Read raw body for HMAC verification
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  if (!verifyInstagramWebhookSignature(rawBody, signature)) {
    console.warn('[instagram/webhook] Invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: InstagramWebhookPayload;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate processing), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached `processInstagramWebhook(body)`
  // promise: on serverless platforms (we run on Vercel) the function can be
  // frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. `after()` hands the
  // callback to the runtime, which keeps the function alive until it resolves
  // (within the route's maxDuration).
  if (body.object === 'instagram' && body.entry) {
    after(async () => {
      try {
        await processInstagramWebhook(body);
      } catch (error) {
        console.error('[instagram/webhook] processing error:', error);
      }
    });
  }

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

// ============================================================
// Webhook processing logic
// ============================================================

export function extractInstagramMessagingEvents(entry: InstagramWebhookEntry) {
  const events: InstagramMessagingEntry[] = [];

  if (entry.messaging) {
    events.push(...entry.messaging);
  }

  if (entry.changes) {
    for (const change of entry.changes) {
      if (!change?.value) continue;
      if (change.value.messaging) {
        events.push(...change.value.messaging);
        continue;
      }

      if (!change.value.messages) continue;

      for (const message of change.value.messages) {
        if (!message || !message.from) continue;

        const text =
          typeof message.text === 'string'
            ? message.text
            : message.text?.body;

        events.push({
          sender: { id: message.from },
          recipient: { id: entry.id ?? "" },
          timestamp: message.timestamp ?? Date.now(),
          message: {
            mid: message.id,
            text,
          },
        });
      }
    }
  }

  return events;
}

async function processInstagramWebhook(body: InstagramWebhookPayload) {
  if (!body.entry) return;

  for (const entry of body.entry) {
    const events = extractInstagramMessagingEvents(entry);
    if (!events.length) continue;

    for (const event of events) {
      // Isolate each event â€” a failure on one DM must not abort the
      // rest of the batch (or leave Meta to retry the whole payload).
      try {
        await handleInstagramMessagingEvent(event, entry.id ?? "");
      } catch (err) {
        console.error('[instagram/webhook] event handling error:', err);
      }
    }
  }
}

/**
 * Best-effort DM send. A failure to send must not abort processing of
 * the rest of the batch, so swallow errors with a log instead of letting
 * them propagate up to `processInstagramWebhook`.
 */
async function trySendInstagramDm(args: SendInstagramDmArgs, label: string) {
  try {
    await sendInstagramDm(args);
    return true;
  } catch (err) {
    console.error(
      `[instagram/webhook] Failed to send DM (${label}):`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

async function handleInstagramMessagingEvent(
  event: InstagramMessagingEntry,
  igUserId: string
) {
  // Only process text messages from users (not echoes of our own replies)
  if (!event.message || !event.message.text || event.message.is_echo) return;

  const senderId = event.sender?.id;
  if (!senderId) return;
  const messageText = event.message.text.trim();

  if (!messageText) return;

  console.log(
    `[instagram/webhook] DM from ${senderId}: "${messageText}"`
  );

  // 1. Find the Instagram config for this IG Business Account
  const db = supabaseAdmin();
  const { data: config, error: configError } = await db
    .from('instagram_config')
    .select('*')
    .eq('ig_user_id', igUserId)
    .maybeSingle();

  if (configError || !config) {
    console.error(
      '[instagram/webhook] No config found for ig_user_id:',
      igUserId
    );
    return;
  }

  // Update last_webhook_at. Best-effort â€” failures here must not break
  // the main DM-reply flow, so use a try/catch (NOT `.catch()`: the
  // Supabase query builder is thenable but has no `.catch` method, and
  // chaining one throws `TypeError` before the reply is ever sent).
  try {
    const { error: touchError } = await db
      .from('instagram_config')
      .update({ last_webhook_at: new Date().toISOString() })
      .eq('id', config.id);
    if (touchError) {
      console.warn('[instagram/webhook] Failed to update last_webhook_at:', touchError);
    }
  } catch (err) {
    console.warn('[instagram/webhook] last_webhook_at update threw:', err);
  }

  // Decrypt the access token
  let accessToken: string;
  try {
    accessToken = decrypt(config.access_token);
  } catch {
    console.error('[instagram/webhook] Failed to decrypt access token');
    return;
  }

  // 2. Try to find a product matching this keyword
  const keyword = messageText.toUpperCase();
  const { data: product, error: productError } = await db
    .from('products')
    .select('id, name, price, currency, trigger_keyword')
    .eq('account_id', config.account_id)
    .eq('trigger_keyword', keyword)
    .eq('status', 'active')
    .maybeSingle();

  if (productError) {
    console.error('[instagram/webhook] Product lookup error:', productError);
    return;
  }

  if (!product) {
    // No product matches â€” send a helpful fallback message
    console.log(
      `[instagram/webhook] No product found for keyword: "${keyword}"`
    );

    // Get all active products to suggest available keywords
    const { data: activeProducts } = await db
      .from('products')
      .select('trigger_keyword, name')
      .eq('account_id', config.account_id)
      .eq('status', 'active')
      .limit(10);

    if (activeProducts && activeProducts.length > 0) {
      const suggestions = (activeProducts as Array<{trigger_keyword: string; name: string}>)
        .map((p) => `${p.trigger_keyword} â€” ${p.name}`)
        .join('\n');

      const sent = await trySendInstagramDm(
        {
          igUserId,
          accessToken,
          recipientId: senderId,
          text: `Hi! I couldn't find a product for "${keyword}". Here are the available keywords:\n\n${suggestions}\n\nReply with a keyword to get started! ðŸ‘‹`,
        },
        'fallback-with-suggestions'
      );
      if (sent) {
        console.log(`[instagram/webhook] Sent fallback DM for "${keyword}" to ${senderId}`);
      }
    } else {
      const sent = await trySendInstagramDm(
        {
          igUserId,
          accessToken,
          recipientId: senderId,
          text: `Hi! Thanks for your message. I couldn't find anything matching "${keyword}". Please check back later for available products! ðŸ‘‹`,
        },
        'fallback'
      );
      if (sent) {
        console.log(`[instagram/webhook] Sent fallback DM for "${keyword}" to ${senderId}`);
      }
    }
    return;
  }

  console.log(
    `[instagram/webhook] Matched product: "${product.name}" (keyword: ${product.trigger_keyword})`
  );

  // 3. Get the WhatsApp config for this account to generate wa.me link
  const { data: whatsappConfig, error: whatsappError } = await db
    .from('whatsapp_config')
    .select('display_phone_number')
    .eq('account_id', config.account_id)
    .maybeSingle();

  if (whatsappError || !whatsappConfig?.display_phone_number) {
    console.error('[instagram/webhook] No WhatsApp config for account');
    const sent = await trySendInstagramDm(
      {
        igUserId,
        accessToken,
        recipientId: senderId,
        text: `Thanks for your interest in "${product.name}"! Please complete your purchase on WhatsApp. I'll be right there! ðŸ›’`,
      },
      'no-whatsapp-config'
    );
    if (sent) {
      console.log(`[instagram/webhook] Sent WhatsApp fallback DM for "${product.name}" to ${senderId}`);
    }
    return;
  }

  // 4. Build the WhatsApp deep link
  const phone = whatsappConfig.display_phone_number.replace(/\D/g, '');
  const waLink = `https://wa.me/${phone}?text=${encodeURIComponent(product.trigger_keyword)}`;

  // 5. Send the wa.me link back on Instagram DM
  const priceStr = `${product.currency} ${Number(product.price).toFixed(2)}`;
  const sent = await trySendInstagramDm(
    {
      igUserId,
      accessToken,
      recipientId: senderId,
      text: `Great choice! You selected: *${product.name}* (${priceStr})\n\nClick the link below to complete your order on WhatsApp:\n${waLink}\n\nJust press send, and our team will help you out! ðŸš€`,
    },
    'product-link'
  );

  if (sent) {
    console.log(
      `[instagram/webhook] Sent wa.me link for "${product.name}" to ${senderId}`
    );
  }
}







import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { sendInstagramDm } from '@/lib/instagram/client';
import type {
  InstagramWebhookPayload,
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
// GET  — Webhook verification (hub.challenge)
// POST — Receive incoming DMs, detect keywords, respond with wa.me link
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
 * GET — Instagram webhook verification.
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
        // Malformed / wrong-key token row — skip it
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
 * POST — Receive Instagram DM events.
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

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
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

async function processInstagramWebhook(body: InstagramWebhookPayload) {
  if (!body.entry) return;

  for (const entry of body.entry) {
    if (!entry.messaging) continue;

    for (const event of entry.messaging) {
      // Isolate each event — a failure on one DM must not abort the
      // rest of the batch (or leave Meta to retry the whole payload).
      try {
        await handleInstagramMessagingEvent(event, entry.id);
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
  } catch (err) {
    console.error(
      `[instagram/webhook] Failed to send DM (${label}):`,
      err instanceof Error ? err.message : err
    );
  }
}

async function handleInstagramMessagingEvent(
  event: InstagramMessagingEntry,
  igUserId: string
) {
  // Only process text messages from users (not echoes of our own replies)
  if (!event.message || !event.message.text || event.message.is_echo) return;

  const senderId = event.sender.id;
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

  // Update last_webhook_at. Best-effort — failures here must not break
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
    // No product matches — send a helpful fallback message
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
        .map((p) => `${p.trigger_keyword} — ${p.name}`)
        .join('\n');

      await trySendInstagramDm(
        {
          igUserId,
          accessToken,
          recipientId: senderId,
          text: `Hi! I couldn't find a product for "${keyword}". Here are the available keywords:\n\n${suggestions}\n\nReply with a keyword to get started! 👋`,
        },
        'fallback-with-suggestions'
      );
    } else {
      await trySendInstagramDm(
        {
          igUserId,
          accessToken,
          recipientId: senderId,
          text: `Hi! Thanks for your message. I couldn't find anything matching "${keyword}". Please check back later for available products! 👋`,
        },
        'fallback'
      );
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
    await trySendInstagramDm(
      {
        igUserId,
        accessToken,
        recipientId: senderId,
        text: `Thanks for your interest in "${product.name}"! Please complete your purchase on WhatsApp. I'll be right there! 🛒`,
      },
      'no-whatsapp-config'
    );
    return;
  }

  // 4. Build the WhatsApp deep link
  const phone = whatsappConfig.display_phone_number.replace(/\D/g, '');
  const waLink = `https://wa.me/${phone}?text=${encodeURIComponent(product.trigger_keyword)}`;

  // 5. Send the wa.me link back on Instagram DM
  const priceStr = `${product.currency} ${Number(product.price).toFixed(2)}`;
  await trySendInstagramDm(
    {
      igUserId,
      accessToken,
      recipientId: senderId,
      text: `Great choice! You selected: *${product.name}* (${priceStr})\n\nClick the link below to complete your order on WhatsApp:\n${waLink}\n\nJust press send, and our team will help you out! 🚀`,
    },
    'product-link'
  );

  console.log(
    `[instagram/webhook] Sent wa.me link for "${product.name}" to ${senderId}`
  );
}


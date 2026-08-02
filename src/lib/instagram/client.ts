/**
 * Instagram Graph API client — DM integration.
 *
 * Uses the same Meta Graph API base (v21.0) as the WhatsApp integration.
 * Requires an Instagram Business Account connected to a Facebook Page,
 * and a Page Access Token with `instagram_manage_messages` permission.
 *
 * API Reference:
 *   https://developers.facebook.com/docs/instagram-api/guides/messaging
 */

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string };
}

interface MetaPermissionResponse {
  data?: Array<{ permission?: string; status?: string }>;
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const data = (await response.json()) as MetaErrorResponse;
    if (data.error?.message) message = data.error.message;
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message);
}

export interface InstagramUserInfo {
  id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
}

export interface VerifyInstagramCredentialsArgs {
  igUserId: string;
  accessToken: string;
  requiredPermissions?: string[];
}

export async function verifyInstagramCredentials(
  args: VerifyInstagramCredentialsArgs
): Promise<InstagramUserInfo> {
  const { igUserId, accessToken, requiredPermissions = ['instagram_manage_messages'] } = args;
  const url = `${META_API_BASE}/${igUserId}?fields=id,username,name,profile_picture_url`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }

  const userInfo = (await response.json()) as InstagramUserInfo;

  try {
    const permissionsUrl = `${META_API_BASE}/me/permissions`;
    const permissionsResponse = await fetch(permissionsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (permissionsResponse.ok) {
      const permissionsData = (await permissionsResponse.json()) as MetaPermissionResponse;
      const grantedPermissions = (permissionsData.data ?? [])
        .map((entry) => entry.permission)
        .filter((permission): permission is string => Boolean(permission));

      const missingPermissions = requiredPermissions.filter(
        (permission) => !grantedPermissions.includes(permission)
      );

      if (missingPermissions.length > 0) {
        throw new Error(
          `Token is valid for the Instagram account but missing required permission(s): ${missingPermissions.join(', ')}. Use a Page Access Token with instagram_manage_messages for the connected Facebook Page.`
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('missing required permission')) {
      throw error;
    }
    console.warn('[instagram] Could not inspect token permissions:', error);
  }

  return userInfo;
}

export interface SendInstagramDmArgs {
  igUserId: string;
  accessToken: string;
  recipientId: string;
  text: string;
}

export interface SendInstagramDmResult {
  messageId: string;
}

export async function sendInstagramDm(
  args: SendInstagramDmArgs
): Promise<SendInstagramDmResult> {
  const { igUserId, accessToken, recipientId, text } = args;
  const url = `${META_API_BASE}/${igUserId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });

  if (!response.ok) {
    await throwMetaError(response, `Failed to send Instagram DM: ${response.status}`);
  }

  const data = await response.json();
  return { messageId: data.message_id ?? data.id ?? 'unknown' };
}

export interface InstagramWebhookVerifyParams {
  mode: string | null;
  challenge: string | null;
  verifyToken: string | null;
}

export interface InstagramWebhookVerifyResult {
  verified: boolean;
  challenge?: string;
}

export function verifyInstagramWebhook(
  params: InstagramWebhookVerifyParams,
  expectedToken: string
): InstagramWebhookVerifyResult {
  if (
    params.mode === 'subscribe' &&
    params.challenge &&
    params.verifyToken === expectedToken
  ) {
    return { verified: true, challenge: params.challenge };
  }
  return { verified: false };
}

export interface InstagramSender {
  id: string;
  user_id?: string;
}

export interface InstagramMessage {
  mid: string;
  text?: string;
  is_echo?: boolean;
  quick_reply?: { payload: string };
  reply_to?: { mid: string };
  attachments?: Array<{
    type: string;
    payload: { url?: string; sticker_id?: string };
  }>;
}

export interface InstagramChangedMessage {
  id: string;
  from: string;
  text?: string | { body?: string };
  timestamp?: number;
  type?: string;
}

export interface InstagramMessagingEntry {
  sender?: InstagramSender;
  recipient_id?: string;
  recipient?: { id: string };
  timestamp?: number;
  message?: InstagramMessage;
}

export interface InstagramWebhookEntry {
  id?: string;
  time?: number;
  messaging?: InstagramMessagingEntry[];
  changes?: Array<{
    field?: string;
    value?: {
      messaging?: InstagramMessagingEntry[];
      messages?: InstagramChangedMessage[];
    };
  }>;
}

export interface InstagramWebhookPayload {
  object?: string;
  entry?: InstagramWebhookEntry[];
}


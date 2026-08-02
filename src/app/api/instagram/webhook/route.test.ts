import { describe, expect, it, vi } from 'vitest';

// The route imports `after` and `NextResponse` from `next/server`, which
// isn't resolvable in the vitest node environment (Next.js runtime only).
// Provide a lightweight mock so the module can be imported for the pure
// event-extraction unit tests below.
vi.mock('next/server', () => ({
  after: vi.fn((fn: () => void | Promise<void>) => fn()),
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      }),
  },
}));

// The route imports `createClient` directly from `@supabase/supabase-js`,
// which throws at module load in the vitest node environment. We only test
// the pure event-extraction helper, so a no-op mock is sufficient.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    })),
  })),
}));

import { extractInstagramMessagingEvents } from './route';

describe('Instagram webhook event extraction', () => {
  it('extracts events from legacy entry.messaging payloads', () => {
    const entry = {
      id: '17841400000000000',
      time: 1680000000,
      messaging: [
        {
          sender: { id: '123' },
          recipient: { id: '17841400000000000' },
          timestamp: 1680000000,
          message: { mid: 'm1', text: 'hello' },
        },
      ],
    };

    const events = extractInstagramMessagingEvents(entry as any);
    expect(events).toHaveLength(1);
    expect(events[0]?.sender?.id).toBe('123');
    expect(events[0]?.message?.text).toBe('hello');
  });

  it('extracts events from entry.changes payloads with text string messages', () => {
    const entry = {
      id: '17841400000000000',
      changes: [
        {
          field: 'messages',
          value: {
            messages: [
              { id: 'm2', from: '456', text: 'buy', timestamp: 1680000001 },
            ],
          },
        },
      ],
    };

    const events = extractInstagramMessagingEvents(entry as any);
    expect(events).toHaveLength(1);
    expect(events[0]?.sender?.id).toBe('456');
    expect(events[0]?.message?.text).toBe('buy');
  });

  it('extracts events from entry.changes payloads with text body objects', () => {
    const entry = {
      id: '17841400000000000',
      changes: [
        {
          field: 'messages',
          value: {
            messages: [
              { id: 'm3', from: '789', text: { body: 'buy' }, timestamp: 1680000002 },
            ],
          },
        },
      ],
    };

    const events = extractInstagramMessagingEvents(entry as any);
    expect(events).toHaveLength(1);
    expect(events[0]?.sender?.id).toBe('789');
    expect(events[0]?.message?.text).toBe('buy');
  });
});


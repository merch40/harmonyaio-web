import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';

const env = { BREVO_API_KEY: 'test-only-key', BREVO_LIST_ID: '6' };
const signup = (email, bindings = env) => worker.fetch(new Request('https://www.harmonyaio.com/api/signup', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
}), bindings, {});

afterEach(() => vi.unstubAllGlobals());

describe('the public signup endpoint', () => {
  it.each([201, 204])('accepts Brevo %s and preserves plus-addressing on the configured list', async status => {
    const upstream = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal('fetch', upstream);
    const response = await signup(' Demo+Harmony@outlook.com ');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, options] = upstream.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/contacts');
    expect(JSON.parse(options.body)).toEqual({ email: 'demo+harmony@outlook.com', listIds: [6], updateEnabled: true });
  });

  it('rejects an invalid address before contacting the provider', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await signup('invalid')).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('fails visibly if deployment secrets are missing', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const response = await signup('demo@example.com', {});
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Server not configured' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('does not report success when the provider rejects the contact', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    const response = await signup('demo@example.com');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Could not process signup' });
  });
});

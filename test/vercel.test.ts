import { describe, expect, it } from 'vitest';
import { handler } from '../src/vercel.js';

describe('vercel entry', () => {
  it('serves /api/health without a database', async () => {
    const res = await handler(new Request('https://x.local/api/health'));
    expect(res.status).toBe(200);
  });
  it('fails cleanly when DATABASE_URL is missing', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    const res = await handler(new Request('https://x.local/api/status'));
    expect(res.status).toBe(500);
  });
});

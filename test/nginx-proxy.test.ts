import { env, createExecutionContext } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { ensureSchema, listRawTables, rawTable } from '../src/db';
import { handleIngest } from '../src/ingest';
import { partsFor } from '../src/time';

const secret = 'test-token-for-nginx-discovery-and-proxy';
const bindings: Env & { NGINX_PROXY_SECRET: string } = { ...env, NGINX_PROXY_SECRET: secret };

beforeEach(async () => {
  await ensureSchema(env.DB);
  for (const table of await listRawTables(env.DB)) await env.DB.prepare(`DROP TABLE ${table}`).run();
  await env.DB.prepare('DELETE FROM sites').run();
});

async function sync(domains: unknown, token = secret) {
  return worker.fetch(new Request('https://example.com/__nginx/sites/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-edgemetry-proxy-token': token },
    body: JSON.stringify({ domains }),
  }), bindings, createExecutionContext());
}

it('rejects missing or incorrect discovery credentials without creating a site', async () => {
  expect((await sync(['a.mrqiang.top'], '')).status).toBe(403);
  expect((await sync(['a.mrqiang.top'], 'wrong')).status).toBe(403);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sites').first<{n:number}>())?.n).toBe(0);
});

it('limits discovery to the permitted domain family and validates the whole batch first', async () => {
  expect((await sync(['a.mrqiang.top', 'mrqiang.top.attacker.example'])).status).toBe(400);
  expect((await sync(['*.mrqiang.top'])).status).toBe(400);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sites').first<{n:number}>())?.n).toBe(0);
});

it('registers domains idempotently and normalizes www consistently with Edgemetry', async () => {
  expect((await sync(['www.mrqiang.top', 'a.mrqiang.top'])).status).toBe(200);
  const again = await sync(['mrqiang.top', 'a.mrqiang.top']);
  expect(await again.json()).toEqual({ domains: ['mrqiang.top', 'a.mrqiang.top'], created: [] });
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sites').first<{n:number}>())?.n).toBe(2);
});

it('uses forwarded visitor IP only with the correct proxy credential', async () => {
  await sync(['a.mrqiang.top']);
  const send = (ip: string, token: string) => handleIngest(new Request('https://example.com/em', {
    method: 'POST', headers: {
      'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
      'cf-connecting-ip': '192.0.2.1',
      'x-edgemetry-client-ip': ip,
      'x-edgemetry-proxy-token': token,
    }, body: JSON.stringify({ d: 'a.mrqiang.top', u: 'https://a.mrqiang.top/', n: 'pageview' }),
  }), bindings);
  expect((await send('198.51.100.1', 'wrong')).status).toBe(204);
  expect((await send('198.51.100.2', 'wrong')).status).toBe(204);
  expect((await send('198.51.100.3', secret)).status).toBe(204);
  expect((await send('198.51.100.4', secret)).status).toBe(204);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT visitor) AS visitors FROM ${rawTable(partsFor(new Date()).suffix)}`).first<{n:number;visitors:number}>();
  expect(row).toEqual({ n: 4, visitors: 3 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('Vercel entrypoint mounts the owner work-scope page', async () => {
  const values: Record<string, string> = {
    CONDUCTOR_PUBLIC_URL: 'http://127.0.0.1',
    CONDUCTOR_OWNER_PASSWORD: 'test-owner-password',
    CONDUCTOR_SESSION_SECRET: 'test-owner-session-secret-long-enough',
    CONDUCTOR_COOKIE_SECURE: '0',
    CONDUCTOR_PROJECTS_JSON: JSON.stringify([{ id: 'conductor', repository: 'pyralisxc/Conductor' }]),
    UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
    CONDUCTOR_ENABLE_GITHUB_MUTATIONS: '0',
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const { default: handler } = await import('../api/index.js');
  const server = createServer((req, res) => void handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const signedOut = await fetch(`${base}/work-scope`, { redirect: 'manual' });
    assert.equal(signedOut.status, 303);
    assert.match(signedOut.headers.get('location') ?? '', /login/);
    const login = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ password: values.CONDUCTOR_OWNER_PASSWORD, returnTo: '/work-scope' }),
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/work-scope');
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const page = await fetch(`${base}/work-scope`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Additional code work repositories/);
  } finally {
    server.close();
    await once(server, 'close');
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

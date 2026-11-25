import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SignJWT } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { disposableRedis } from './helpers/disposable-redis.js';
import { shortLivedInstallationToken } from '../src/connections/vercel/short-lived-token.js';
import { VersionedProviderCredentialVault } from '../src/connections/universal/credential-vault.js';
import { derivedSecret } from '../src/transport/owner-auth.js';
import { disconnectVercelInstallation, vercelInstallationToken } from '../src/connections/vercel/installation.js';

const credentialKey = 'vercel-fixture-provider-key-at-least-32-characters';
const vault = new VersionedProviderCredentialVault({ legacyPurpose: 'vercel-installation', currentKey: credentialKey });
const installationId = 'icfg_existing';
const installationKey = `conductor:vercel:connection:v1:installation:${installationId}`;
const record = () => vault.seal(JSON.stringify({ configurationId: installationId, teamId: 'team_fixture',
  connectedAt: '2026-01-01T00:00:00Z', token: 'legacy-token-must-never-be-sent' }));
const tokenBody = (token = 'short-fixture', expires = 3600) => ({ access_token: token,
  expires_in: expires, token_type: 'Bearer', installation_id: installationId, team_id: 'team_fixture' });

test('installation refresh uses actual Redis coordination, expiry and disconnect fences', async t => {
  const redis = await disposableRedis();
  try {
    let clock = Date.now(), requests = 0;
    let response = () => Response.json(tokenBody());
    const raw = record();
    await redis.client.set(installationKey, raw);
    const options = { redis: redis.client, vault, installationKey, installationRecord: raw,
      installationId, teamId: 'team_fixture', clientId: 'fixture-client', clientSecret: 'fixture-secret', now: () => clock,
      fetch: (async (url, init) => {
        requests++;
        assert.equal(url, 'https://api.vercel.com/v2/oauth/access_token');
        assert.equal(new Headers(init?.headers).get('authorization'), `Basic ${Buffer.from('fixture-client:fixture-secret').toString('base64')}`);
        const body = new URLSearchParams(String(init?.body));
        assert.deepEqual([...body], [['grant_type', 'client_credentials'], ['installation_id', installationId]]);
        assert.equal(init?.redirect, 'error');
        return response();
      }) as typeof fetch };
    await t.test('concurrent independent callers mint once and encrypt the cache', async () => {
      assert.deepEqual(await Promise.all(Array.from({length: 6}, () => shortLivedInstallationToken(options))), Array(6).fill('short-fixture'));
      assert.equal(requests, 1);
      const keys = await redis.command(['KEYS', 'conductor:vercel:short-lived:*']) as string[];
      assert.equal(keys.length, 1);
      assert.doesNotMatch(String(await redis.command(['GET', keys[0]!])), /short-fixture|fixture-secret/);
      assert.equal(await redis.client.get(installationKey), raw);
    });
    await t.test('refreshes before expiry; 5xx uses only still-valid short token with cooldown', async () => {
      clock += 3500000;
      response = () => Response.json({ error: { message: 'secret-body' } }, { status: 503 });
      assert.equal(await shortLivedInstallationToken(options), 'short-fixture');
      const count = requests;
      assert.equal(await shortLivedInstallationToken(options), 'short-fixture');
      assert.equal(requests, count);
      clock += 110000;
      await assert.rejects(shortLivedInstallationToken(options), /token unavailable/);
    });
    await t.test('invalid_grant is terminal for the unchanged installation; no legacy fallback', async () => {
      clock += 60000;
      response = () => Response.json({ error: { code: 'invalid_grant', message: 'secret-body' } }, { status: 400 });
      await assert.rejects(shortLivedInstallationToken(options), /invalid_grant/);
      const count = requests; clock += 2 * 86400000;
      await assert.rejects(shortLivedInstallationToken(options), /invalid_grant/);
      assert.equal(requests, count);
    });
    await t.test('changed connection cannot publish or return an in-flight token', async () => {
      const replacement = record(); await redis.client.set(installationKey, replacement);
      const racing = { ...options, installationRecord: replacement, fetch: (async () => {
        await redis.client.del(installationKey); return Response.json(tokenBody('racing-token'));
      }) as typeof fetch };
      await assert.rejects(shortLivedInstallationToken(racing), /connection changed/);
      assert.equal(await redis.client.get(installationKey), null);
    });
    await t.test('wrong response installation/team, malformed expiry and redirects fail closed', async () => {
      for (const bad of [{installation_id:'icfg_foreign'}, {team_id:'team_foreign'}, {expires_in:0}, {expires_in:7200}]) {
        const fresh = record(); await redis.client.set(installationKey, fresh);
        await assert.rejects(shortLivedInstallationToken({...options,installationRecord:fresh,
          fetch: (async () => Response.json({...tokenBody(),...bad})) as typeof fetch}), /identity or expiry invalid/);
      }
      const fresh = record(); await redis.client.set(installationKey, fresh);
      await assert.rejects(shortLivedInstallationToken({...options,installationRecord:fresh,
        fetch: (async () => new Response(null,{status:302,headers:{location:'https://other.test'}})) as typeof fetch}), /unavailable/);
    });
    await t.test('rate limits back off, invalid clients fail closed, storage failure never falls back', async () => {
      const fresh=record(); await redis.client.set(installationKey,fresh); let calls=0;
      const limited={...options,installationRecord:fresh,fetch:(async()=>{calls++;return Response.json({error:{code:'rate_limit_exceeded'}},{status:429,headers:{'retry-after':'120'}});}) as typeof fetch};
      await assert.rejects(shortLivedInstallationToken(limited),/unavailable/);
      await assert.rejects(shortLivedInstallationToken(limited),/temporarily unavailable/);
      assert.equal(calls,1);clock+=121000;
      await assert.rejects(shortLivedInstallationToken({...limited,fetch:(async()=>Response.json({error:{code:'invalid_client',message:'private-provider-detail'}},{status:401})) as typeof fetch}),/invalid_client/);
      clock+=86400000;
      await assert.rejects(shortLivedInstallationToken(limited),/invalid_client/);
      assert.equal(await shortLivedInstallationToken({...limited,clientSecret:'replacement-fixture-secret',fetch:(async()=>Response.json(tokenBody())) as typeof fetch}),'short-fixture');
      await assert.rejects(shortLivedInstallationToken({...limited,redis:{get:async()=>{throw Error('Redis unavailable');}} as unknown as typeof redis.client}),/Redis unavailable/);
      assert.equal(calls,1);
    });
    await t.test('shorter provider expiry is honored and refreshed, not assumed to be one hour', async () => {
      const fresh=record(); await redis.client.set(installationKey,fresh); let calls=0;
      const short={...options,installationRecord:fresh,fetch:(async()=>Response.json(tokenBody(`short-${++calls}`,60))) as typeof fetch};
      assert.equal(await shortLivedInstallationToken(short),'short-1');
      clock+=31000;
      assert.equal(await shortLivedInstallationToken(short),'short-2');
    });
  } finally { await redis.close(); }
});

test('deployed HTTP entrypoint: authenticated MCP deployment/status and audit use renewable existing-installation tokens', async () => {
  const redis = await disposableRedis();
  const values: Record<string,string|undefined> = {
    VERCEL: undefined, VERCEL_ENV:'preview', CONDUCTOR_PUBLIC_URL:'http://127.0.0.1',
    CONDUCTOR_COOKIE_SECURE:'0', CONDUCTOR_OWNER_PASSWORD:'fixture-owner-password', CONDUCTOR_SESSION_SECRET:'fixture-session-secret-at-least-32-characters',
    CONDUCTOR_PROVIDER_CREDENTIAL_KEY:credentialKey, CONDUCTOR_ENABLE_GITHUB_MUTATIONS:'0',
    CONDUCTOR_PR_EVENTS_JSON:undefined, CONDUCTOR_PR_EVENTS_DISCOVERY_ONLY:undefined,
    CONDUCTOR_PROJECTS_JSON:JSON.stringify([{id:'conductor',repository:'pyralisxc/Conductor',vercelProject:'prj_fixture',vercelTeamId:'team_fixture',vercelConnectionId:installationId}]),
    CONDUCTOR_VERCEL_BINDINGS_JSON:undefined, CONDUCTOR_VERCEL_RUNTIME_LOG_BINDINGS_JSON:undefined,
    CONDUCTOR_VERCEL_CLIENT_ID:'fixture-client', CONDUCTOR_VERCEL_CLIENT_SECRET:'fixture-secret',CONDUCTOR_VERCEL_INTEGRATION_SLUG:'fixture',
    UPSTASH_REDIS_REST_URL:redis.url,UPSTASH_REDIS_REST_TOKEN:'disposable-test-only',
  };
  const previous=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
  for(const [k,v] of Object.entries(values)) { if(v===undefined)delete process.env[k];else process.env[k]=v; }
  const nativeFetch=globalThis.fetch;
  let mints=0,providerCalls=0;
  globalThis.fetch=(async(input,init)=>{
    const url=new URL(input instanceof Request ? input.url : String(input));
    if(url.hostname!=='api.vercel.com')return nativeFetch(input,init);
    if(url.pathname==='/v2/oauth/access_token') {
      const form=new URLSearchParams(String(init?.body));
      if(form.has('code'))return Response.json({access_token:'authorization-code-token',installation_id:installationId,team_id:'team_fixture'});
      mints++; return Response.json(tokenBody(`short-http-${mints}`));
    }
    providerCalls++;
    assert.equal(new Headers(init?.headers).get('authorization'),`Bearer short-http-${mints}`);
    assert.equal(url.searchParams.get('teamId'),'team_fixture');
    if(url.pathname==='/v9/projects/prj_fixture')return Response.json({id:'prj_fixture',name:'conductor',link:{type:'github',org:'pyralisxc',repo:'Conductor',productionBranch:'main'}});
    if(url.pathname==='/v6/deployments')return Response.json({deployments:[],pagination:{next:null}});
    if(url.pathname.endsWith('/env'))return Response.json({envs:[]});
    if(url.pathname==='/v2/teams/team_fixture')return Response.json({id:'team_fixture',billing:{plan:'pro'}});
    return Response.json({domains:[],aliases:[],environments:[],projects:[],pagination:{next:null}});
  }) as typeof fetch;
  const {default: handler}=await import('../api/index.js');
  const server=createServer((req,res)=>void handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  const client=new Client({name:'migration-entrypoint-test',version:'1.0.0'});
  try {
    await redis.client.set(installationKey,record());
    assert.equal((await nativeFetch(`${base}/mcp`,{method:'POST'})).status,401);
    const jwt=await new SignJWT({token_use:'access',scope:'conductor.read',client_id:'fixture-client'})
      .setProtectedHeader({alg:'HS256'}).setIssuer('http://127.0.0.1').setAudience('http://127.0.0.1/mcp')
      .setSubject('owner').setExpirationTime('5m').sign(derivedSecret('oauth-token'));
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${jwt}`}}}));
    for(const name of ['deployment.status','deployment.audit']) {
      const result=await client.callTool({name,arguments:{project:{id:'conductor',repository:'pyralisxc/Conductor'}}});
      assert.equal((result.structuredContent as {receipt:{status:string}}).receipt.status,'succeeded',JSON.stringify(result));
      assert.doesNotMatch(JSON.stringify(result),/short-http|legacy-token|fixture-secret/);
    }
    assert.equal(mints,1);assert.ok(providerCalls>5);
    // A fresh runtime instance shares the encrypted cache; changed account never mints.
    assert.equal(await vercelInstallationToken(installationId,'team_wrong'),undefined);
    assert.equal(await vercelInstallationToken(installationId,'team_fixture'),'short-http-1');
    await disconnectVercelInstallation(installationId);
    const calls=providerCalls;
    const denied=await client.callTool({name:'deployment.status',arguments:{project:{id:'conductor'}}});
    assert.equal((denied.structuredContent as {receipt:{status:string}}).receipt.status,'failed');
    assert.equal(providerCalls,calls);
    // Exercise the owner connection callback too: no real provider consent or credentials.
    const login=await nativeFetch(`${base}/login`,{method:'POST',redirect:'manual',body:new URLSearchParams({password:'fixture-owner-password',returnTo:'/connections/vercel'})});
    assert.equal(login.status,303);const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
    const page=await nativeFetch(`${base}/connections/vercel`,{headers:{cookie}});assert.equal(page.status,200);
    const html=await page.text();
    const csrf=html.match(/action="\/connections\/vercel\/start"><input type="hidden" name="csrf" value="([^"]+)"/)?.[1];assert.ok(csrf);
    const start=await nativeFetch(`${base}/connections/vercel/start`,{method:'POST',redirect:'manual',headers:{cookie},body:new URLSearchParams({csrf})});
    assert.equal(start.status,303);const state=new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback=await nativeFetch(`${base}/connections/vercel/callback?${new URLSearchParams({state,code:'fixture-code',configurationId:installationId,teamId:'team_fixture'})}`,{redirect:'manual',headers:{cookie}});
    assert.equal(callback.status,303);
    // The record remains compatible with unchanged Production/rollback readers, never used for Preview calls.
    const stored=await redis.client.get<string>(installationKey);assert.ok(stored);
    assert.equal(JSON.parse(vault.open(stored).plaintext).token,'authorization-code-token');
    assert.equal(await vercelInstallationToken(installationId,'team_fixture'),'short-http-2');
  } finally {
    await client.close();server.close();await once(server,'close');globalThis.fetch=nativeFetch;
    for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    await redis.close();
  }
});

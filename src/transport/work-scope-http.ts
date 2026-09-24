import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { derivedSecret, ownerSessionValid } from './owner-auth.js';
import { parseWorkScopeGrant, type WorkScopeStore } from './work-scope.js';

function csrf(): string {
  return createHmac('sha256', derivedSecret('work-scope-form')).update('owner-edit').digest('base64url');
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function escape(value: string): string {
  return value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 4096) throw new Error('Form is too large');
  }
  return new URLSearchParams(body);
}

export function createWorkScopeHttpHandler(store: WorkScopeStore) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== '/work-scope') return false;
    res.setHeader('Cache-Control', 'no-store');
    if (!ownerSessionValid(req)) {
      res.statusCode = 303;
      res.setHeader('Location', '/login?returnTo=%2Fwork-scope');
      res.end();
      return true;
    }
    let message = '';
    if (req.method === 'POST') {
      try {
        const values = await form(req);
        if (!equal(values.get('csrf') ?? '', csrf())) throw new Error('Invalid form token');
        const fingerprint = values.get('clientFingerprint')?.trim() ?? '';
        if (!/^[0-9a-f]{64}$/u.test(fingerprint)) throw new Error('Use the fingerprint from work-scope.identity');
        if (values.get('action') === 'revoke') {
          await store.delete(fingerprint);
          message = 'Temporary scope revoked. The default repository applies.';
        } else if (values.get('action') === 'save') {
          const repositories = (key: string) => (values.get(key) ?? '').split(/[\s,]+/u).filter(Boolean);
          const hours = Number(values.get('hours'));
          if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error('Duration must be between 0 and 24 hours');
          const grant = parseWorkScopeGrant({
            primaryRepository: values.get('primaryRepository')?.trim() ?? '',
            routeRepositories: repositories('routeRepositories'),
            developRepositories: repositories('developRepositories'),
            expiresAt: Date.now() + Math.round(hours * 60 * 60 * 1000),
          });
          await store.set(fingerprint, grant);
          message = `Scope saved until ${new Date(grant.expiresAt).toISOString()}.`;
        } else throw new Error('Unknown action');
      } catch (error) {
        res.statusCode = 400;
        message = error instanceof Error ? error.message : 'Scope update failed';
      }
    } else if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end('Method not allowed');
      return true;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conductor work scope</title><style>body{font:16px system-ui;background:#111019;color:#f4f0fa;max-width:620px;margin:5vh auto;padding:24px}label{display:block;margin:18px 0 6px}input{width:100%;box-sizing:border-box;padding:12px;background:#211d2b;border:1px solid #625475;border-radius:8px;color:inherit}button{margin:22px 12px 0 0;padding:12px;background:#55416f;border:0;border-radius:8px;color:inherit}p{line-height:1.5;color:#ccc}</style><h1>Conductor work scope</h1><p>Get the client fingerprint with <code>work-scope.identity</code>. A client can work in its primary repository by default. Add exact repositories for issue routing or code work only when you want to widen its scope. The temporary grant expires automatically.</p>${message ? `<p role="status">${escape(message)}</p>` : ''}<form method="post"><input type="hidden" name="csrf" value="${csrf()}"><label>Client fingerprint</label><input name="clientFingerprint" required pattern="[0-9a-f]{64}" maxlength="64"><label>Primary repository (owner/name)</label><input name="primaryRepository" placeholder="pyralisxc/Conductor"><label>Additional issue routing repositories</label><input name="routeRepositories" placeholder="pyralisxc/Development-OS"><label>Additional code work repositories</label><input name="developRepositories" placeholder="pyralisxc/Development-Intelligence"><label>Duration in hours (maximum 24)</label><input name="hours" type="number" min="0.25" max="24" step="0.25" value="4"><button name="action" value="save">Save scope</button><button name="action" value="revoke">Revoke temporary scope</button></form></html>`);
    return true;
  };
}

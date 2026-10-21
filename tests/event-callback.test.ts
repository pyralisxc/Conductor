import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { safeCallbackPost, validateCallbackRecipient, type CallbackNetwork } from '../src/transport/event-callback.js';

const url = 'https://receiver.example/callback';
const publicAnswer = { address: '8.8.8.8', family: 4 };
const privateAnswer = { address: '127.0.0.1', family: 4 };

/** Controlled Node request boundary; no DNS, socket, TLS or live callback is contacted. */
function networkFixture(initialAnswers: LookupAddress[], status = 204, peer = publicAnswer.address, authorized = true) {
  let answers = initialAnswers;
  let resolves = 0; let requests = 0;
  const peers: string[] = [];
  const network: CallbackNetwork = {
    async resolve(hostname, options) {
      resolves++;
      assert.equal(hostname, 'receiver.example');
      assert.deepEqual(options, { all: true, family: 4 });
      return answers;
    },
    request(destination, options, receive) {
      requests++;
      // A subsequent DNS lookup would now return a private destination.
      answers = [privateAnswer];
      assert.equal(destination.hostname, 'receiver.example');
      assert.equal(destination.protocol, 'https:');
      assert.equal(options.agent, false);
      assert.equal(options.family, 4);
      assert.notEqual(options.rejectUnauthorized, false);
      assert.equal(options.checkServerIdentity, undefined);
      assert.equal(options.method, 'POST');
      assert.ok(options.lookup, 'request must supply its own pinned-address lookup');
      const req = new PassThrough() as unknown as ClientRequest;
      req.once('finish', () => {
        // Exercise the lookup actually passed to the socket layer, after DNS has changed.
        options.lookup!('receiver.example', { family: 4 }, (error, address, family) => {
          if (error) { req.emit('error', error); return; }
          try {
            assert.equal(typeof address, 'string');
            assert.equal(family, 4);
            peers.push(address as string);
            const response = new PassThrough() as unknown as IncomingMessage;
            response.statusCode = status;
            response.headers = { location: 'https://receiver.example/redirected-to-private' };
            receive(response);
            (response as unknown as PassThrough).end();
          } catch (error) { req.emit('error', error); }
        });
      });
      queueMicrotask(() => {
        const socket = Object.assign(new EventEmitter(), { remoteAddress: peer, authorized });
        req.emit('socket', socket); socket.emit('secureConnect');
      });
      return req;
    },
  };
  return { network, peers, resolves: () => resolves, requests: () => requests };
}

test('safeCallbackPost rejects the whole mixed public/private DNS answer set before opening a request', async () => {
  for (const answers of [[publicAnswer, privateAnswer], [privateAnswer, publicAnswer]]) {
    const f = networkFixture(answers);
    await assert.rejects(safeCallbackPost('receiver.example', f.network)(url, '{}', {}), /not public/);
    assert.equal(f.resolves(), 1); assert.equal(f.requests(), 0); assert.deepEqual(f.peers, []);
  }
});

test('safeCallbackPost pins the validated address at the socket lookup despite DNS rebinding', async () => {
  const f = networkFixture([publicAnswer]);
  const post = safeCallbackPost('receiver.example', f.network);
  assert.equal((await post(url, '{}', {})).status, 204);
  assert.deepEqual(f.peers, [publicAnswer.address]);
  assert.equal(f.resolves(), 1); assert.equal(f.requests(), 1);
  // A new delivery must resolve again, detect the rebound private answer, and stop.
  await assert.rejects(post(url, '{}', {}), /not public/);
  assert.equal(f.resolves(), 2); assert.equal(f.requests(), 1);
});

test('safeCallbackPost returns redirects without making a second request or resolving Location', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const f = networkFixture([publicAnswer], status);
    assert.equal((await safeCallbackPost('receiver.example', f.network)(url, '{}', {})).status, status);
    assert.equal(f.resolves(), 1); assert.equal(f.requests(), 1);
    assert.deepEqual(f.peers, [publicAnswer.address]);
  }
});

test('safeCallbackPost fails closed for IPv6-only or empty IPv4 resolution results', async () => {
  for (const answers of [[{ address: '2606:4700:4700::1111', family: 6 }], [{ address: '::1', family: 6 }], []]) {
    const f = networkFixture(answers);
    await assert.rejects(safeCallbackPost('receiver.example', f.network)(url, '{}', {}), /not public/);
    assert.equal(f.resolves(), 1); assert.equal(f.requests(), 0);
  }
});


test('pending preflight resolves only public addresses and opens no request', async () => {
  for (const answers of [[publicAnswer], [publicAnswer, privateAnswer], [{ address: '192.0.2.1', family: 4 }]]) {
    const f = networkFixture(answers);
    if (answers.length === 1 && answers[0] === publicAnswer) await validateCallbackRecipient(url, f.network);
    else await assert.rejects(validateCallbackRecipient(url, f.network), /not public/);
    assert.equal(f.requests(), 0);
  }
});

test('socket mismatch and unauthorized TLS cannot send a body; Node hostname validation remains required', async () => {
  for (const [peer, authorized] of [[privateAnswer.address, true], [publicAnswer.address, false]] as const) {
    const f = networkFixture([publicAnswer], 204, peer, authorized);
    await assert.rejects(safeCallbackPost('receiver.example', f.network)(url, '{}', {}), /socket identity mismatch/);
    assert.deepEqual(f.peers, []); // request body never finished
  }
  assert.ok(checkServerIdentity('receiver.example', { subjectaltname: 'DNS:other.example' } as PeerCertificate));
});

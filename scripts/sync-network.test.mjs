import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import {
  DELIVERY_RELIABLE,
  EVENT_AOI_ENTERED,
  EVENT_AOI_LEFT,
  EVENT_PEER_CONNECTED,
  EVENT_PEER_DISCONNECTED,
  EVENT_RAW,
} from '@tik-choco/mistlib-web';

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) specifier += '.ts';
  return next(specifier, context);
} });
const { SyncNetwork } = await import('../src/lib/sync/network.ts');

test('sync dispatches peer events and ignores AOI events', async () => {
  const received = [];
  const sent = [];
  const node = {
    async init() {},
    onEvent(handler) { this.handler = handler; },
    joinRoom(roomId) { this.roomId = roomId; },
    leaveRoom() {},
    sendMessage(...args) { sent.push(args); },
  };
  const network = new SyncNetwork({
    nodeId: 'local',
    createNode: () => node,
    callbacks: {
      onPeerConnected: id => received.push(['connected', id]),
      onPeerDisconnected: id => received.push(['disconnected', id]),
      onMessage: (id, message) => received.push(['message', id, message]),
    },
  });
  await network.join('sync-room');
  assert.equal(node.roomId, 'sync-room');

  const bytes = text => new TextEncoder().encode(text);
  node.handler(EVENT_PEER_CONNECTED, 'peer', bytes('joined'));
  node.handler(EVENT_AOI_ENTERED, 'other', bytes('entered'));
  node.handler(EVENT_AOI_LEFT, 'other', bytes('left'));
  node.handler(EVENT_PEER_DISCONNECTED, 'peer', bytes('left'));
  const message = { v: 1, type: 'lingo_sync_hello' };
  node.handler(EVENT_RAW, 'peer', bytes(JSON.stringify(message)));
  assert.deepEqual(received, [
    ['connected', 'peer'],
    ['disconnected', 'peer'],
    ['message', 'peer', message],
  ]);

  network.send('peer', message);
  assert.equal(sent[0][0], 'peer');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(sent[0][1])), message);
  assert.equal(sent[0][2], DELIVERY_RELIABLE);
  network.destroy();
});

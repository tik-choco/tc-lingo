import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { registerHooks } from 'node:module';
import { encode, decode, RoomProviderService } from '@tik-choco/mistai';
import { emptyLlmConfig, saveLlmConfig } from '@tik-choco/mistai/llm-config';

// Exercise real mistai consumers/providers with an in-memory transport; only
// replace the browser WASM wrapper and Vite-specific build diagnostics.
class TestMistNode {
  static instance;
  sent = [];
  onSend;
  constructor() { TestMistNode.instance = this; }
  async init() {}
  onEvent(handler) { this.handler = handler; }
  joinRoom(roomId) {
    queueMicrotask(() => this.receive(roomId, {
      v: 1, type: 'provider_hello', models: ['m-42'], services: ['chat', 'oai', 'tts'],
    }));
  }
  leaveRoom() {}
  sendMessage(to, payload, _delivery, roomId) {
    const message = decode(payload);
    this.sent.push({ to, roomId, message });
    this.onSend?.(message, roomId);
  }
  receive(roomId, message) { this.handler(0, 'remote-peer', encode(message), roomId); }
}
globalThis.__roomChatTestNode = TestMistNode;
const wrapperUrl = new URL('../src/vendor/mistlib/wrappers/web/index.js', import.meta.url).href;
const diagnosticsUrl = new URL('../src/lib/mistBuildInfo.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      try { return next(specifier + '.ts', context); }
      catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
        return next(specifier + '/index.ts', context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === wrapperUrl) return { format: 'module', shortCircuit: true,
      source: 'export const MistNode = globalThis.__roomChatTestNode;' };
    if (url === diagnosticsUrl) return { format: 'module', shortCircuit: true,
      source: 'export function captureMistBuildInfo() {} export function markMistLoadError() {}' };
    return next(url, context);
  },
});
globalThis.window = new EventTarget();
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
};
const { rooms, requestNetworkChat, requestNetworkOpenAi, requestNetworkTts } = await import('../src/lib/network.ts');
const { chatJson } = await import('../src/lib/llm.ts');
const { translateUiMessages } = await import('../src/lib/uiTranslation.ts');

afterEach(() => {
  for (const room of ['chat-room', 'vision-room', 'provider-room', 'tts-room', 'tts-provider-room']) rooms.disconnectRoom(room);
  storage.delete('tc-shared-llm-config-v1');
  if (TestMistNode.instance) { TestMistNode.instance.sent = []; TestMistNode.instance.onSend = undefined; }
});

test('room chat uses requestRoomChat, sends task effort on llm_request and streams before completion', { timeout: 5000 }, async t => {
  const messages = [{ role: 'user', content: 'Hello' }];
  const original = rooms.requestRoomChat;
  const calls = [];
  t.mock.method(rooms, 'requestRoomChat', (...args) => { calls.push(args); return original(...args); });
  await rooms.roomConsumer('chat-room').connect('chat-room');
  const node = TestMistNode.instance;

  for (const effort of ['xhigh', 'none', 'future-effort']) {
    const outgoing = Promise.withResolvers();
    node.onSend = message => { if (message.type === 'llm_request') outgoing.resolve(message); };
    const deltas = [];
    const onDelta = (delta, full) => deltas.push([delta, full]);
    let completed = false;
    const reply = requestNetworkChat('chat-room', messages, 'm-42', effort, onDelta)
      .then(text => { completed = true; return text; });
    const request = await outgoing.promise;
    assert.deepEqual(calls.at(-1), ['chat-room', messages, { model: 'm-42', reasoningEffort: effort, onDelta }]);
    assert.equal(request.reasoning_effort, effort);
    assert.equal(request.model, 'm-42');
    assert.deepEqual(request.messages, messages);
    assert.equal('temperature' in request, false);
    node.receive('chat-room', { v: 1, type: 'llm_response_chunk', id: request.id, seq: 0, delta: 'Hel' });
    assert.deepEqual(deltas, [['Hel', 'Hel']]);
    assert.equal(completed, false);
    node.receive('chat-room', { v: 1, type: 'llm_response_chunk', id: request.id, seq: 1, delta: 'lo' });
    assert.deepEqual(deltas, [['Hel', 'Hel'], ['lo', 'Hello']]);
    assert.equal(completed, false);
    node.receive('chat-room', { v: 1, type: 'llm_response_done', id: request.id, content: 'Hello' });
    assert.equal(await reply, 'Hello');
  }
  assert.equal(node.sent.some(({ message }) => message.type === 'oai_request'), false);
});

test('structured chat and UI translation keep each task effort on the room chat wire', { timeout: 5000 }, async () => {
  await rooms.roomConsumer('chat-room').connect('chat-room');
  const node = TestMistNode.instance;
  node.onSend = message => {
    if (message.type === 'llm_request') node.receive('chat-room', {
      v: 1, type: 'llm_response_done', id: message.id, content: '{"label":"Bonjour"}',
    });
  };
  const connection = { kind: 'network', roomId: 'chat-room', model: 'm-42', reasoningEffort: 'high' };
  assert.equal(await chatJson(connection, 'Return JSON', { text: 'Hello' }), '{"label":"Bonjour"}');
  assert.deepEqual(await translateUiMessages({ connection: { ...connection, reasoningEffort: 'none' },
    language: 'French', messages: { label: 'Hello' } }), { label: 'Bonjour' });
  assert.deepEqual(node.sent.filter(({ message }) => message.type === 'llm_request')
    .map(({ message }) => message.reasoning_effort), ['high', 'none']);
  assert.equal(node.sent.some(({ message }) => message.type === 'oai_request'), false);
});

test('vision/OCR image content still uses the OpenAI tunnel', { timeout: 5000 }, async () => {
  // Initialize the shared transport before installing the response handler.
  await rooms.roomConsumer('vision-room').connect('vision-room');
  const node = TestMistNode.instance;
  const body = { model: 'm-42', reasoning_effort: 'low', messages: [{ role: 'user', content: [
    { type: 'text', text: 'Read the text in this image.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  ] }] };
  const responseBody = JSON.stringify({ choices: [{ message: { content: 'Recognized text' } }] });
  node.onSend = message => {
    if (message.type === 'oai_request') {
      assert.equal(message.path, '/chat/completions');
      assert.equal(message.method, 'POST');
      assert.equal(message.last, true);
      assert.deepEqual(JSON.parse(Buffer.from(message.data, 'base64').toString()), body);
      node.receive('vision-room', { v: 1, type: 'oai_response', id: message.id, seq: 0, last: true,
        status: 200, contentType: 'application/json', data: Buffer.from(responseBody).toString('base64') });
    }
  };
  // A fresh tunnel handle joins the existing shared room; announce the peer
  // after that handle has subscribed, just as a real peer would do.
  const response = requestNetworkOpenAi('vision-room', {
    path: '/chat/completions', method: 'POST', contentType: 'application/json', body: JSON.stringify(body),
  });
  await new Promise(resolve => setImmediate(resolve));
  node.receive('vision-room', { v: 1, type: 'provider_hello', models: ['m-42'], services: ['chat', 'oai'] });
  assert.deepEqual(await response, { status: 200, contentType: 'application/json', body: responseBody });
  assert.equal(node.sent.some(({ message }) => message.type === 'oai_request'), true);
  assert.equal(node.sent.some(({ message }) => message.type === 'llm_request'), false);
});

test('mistai room provider forwards inbound effort upstream ahead of its default', { timeout: 5000 }, async t => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: 'Hello' } }] });
  });
  // Use the same consumers/provider service as the app's useRoomProviders hook.
  const config = { v: 1, providers: [
    { id: 'http', label: 'HTTP', baseUrl: 'https://example.test/v1', apiKey: '' },
    { id: 'room', label: 'Room', baseUrl: 'mist-network://provider-room', apiKey: '' },
  ], defaultModel: { providerId: 'http', model: 'm-42' } };
  const service = new RoomProviderService({ config, consumers: rooms, reasoningEffort: 'low',
    roomProvide: { room: { enabled: true, shared: [{ providerId: 'http', model: 'm-42' }] } } });
  t.after(() => service.destroy());
  await new Promise(resolve => {
    if (service.states.room.status === 'connected') return resolve();
    const stop = service.subscribe(() => { if (service.states.room.status === 'connected') { stop(); resolve(); } });
  });
  const node = TestMistNode.instance;
  for (const effort of ['xhigh', 'none', undefined]) {
    const done = Promise.withResolvers();
    node.onSend = message => { if (message.type === 'llm_response_done') done.resolve(); };
    node.receive('provider-room', { v: 1, type: 'llm_request', id: `inbound-${effort}`, model: 'm-42',
      messages: [{ role: 'user', content: 'Hello' }], ...(effort !== undefined ? { reasoning_effort: effort } : {}) });
    await done.promise;
    assert.equal(bodies.at(-1).reasoning_effort, effort ?? 'low');
    assert.equal('temperature' in bodies.at(-1), false);
    assert.equal(bodies.at(-1).stream, true);
  }
});


test('mistai room TTS forwards caller speed/format, falls back to shared speed and reports real MIME', { timeout: 5000 }, async t => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/voices')) return Response.json({ voices: ['alloy'] });
    bodies.push(JSON.parse(init.body));
    return new Response('audio', { headers: { 'Content-Type': 'audio/wav' } });
  });
  const config = { v: 1, providers: [
    { id: 'http', label: 'HTTP', baseUrl: 'https://example.test/v1', apiKey: '' },
    { id: 'room', label: 'Room', baseUrl: 'mist-network://tts-provider-room', apiKey: '' },
  ], tts: { providerId: 'http', model: 'speech-model', voice: 'alloy', speed: 1.5 } };
  const service = new RoomProviderService({ config, consumers: rooms,
    roomProvide: { room: { enabled: true, shared: [] } } });
  t.after(() => service.destroy());
  await new Promise(resolve => {
    if (service.states.room.status === 'connected') return resolve();
    const stop = service.subscribe(() => { if (service.states.room.status === 'connected') { stop(); resolve(); } });
  });
  const node = TestMistNode.instance;
  for (const hints of [{ speed: 2, response_format: 'flac' }, {}, { speed: 10, response_format: 'bogus' }]) {
    const done = Promise.withResolvers();
    node.onSend = message => { if (message.type === 'tts_response') done.resolve(message); };
    node.receive('tts-provider-room', { v: 1, type: 'tts_request', id: 'tts-' + bodies.length, text: 'Hello', ...hints });
    const response = await done.promise;
    assert.equal(bodies.at(-1).speed, hints.speed === 2 ? 2 : 1.5);
    assert.equal(bodies.at(-1).response_format, hints.response_format === 'flac' ? 'flac' : undefined);
    assert.equal(response.mime, 'audio/wav');
  }
});


test('app room TTS helper fills shared speed and lets explicit caller hints win', { timeout: 5000 }, async () => {
  const config = emptyLlmConfig();
  config.tts = { model: 'speech-model', speed: 1.5 };
  saveLlmConfig(config);
  await rooms.roomConsumer('tts-room').connect('tts-room');
  const node = TestMistNode.instance;
  node.onSend = (message, room) => {
    if (message.type === 'tts_request') node.receive(room, { v: 1, type: 'tts_response', id: message.id,
      seq: 0, data: Buffer.from('audio').toString('base64'), last: true, mime: 'audio/wav' });
  };
  for (const hints of [{}, { speed: 2, responseFormat: 'flac' }]) {
    const blob = await requestNetworkTts('tts-room', { text: 'Hello', ...hints });
    const request = node.sent.filter(({ message }) => message.type === 'tts_request').at(-1).message;
    assert.equal(request.speed, hints.speed ?? 1.5);
    assert.equal(request.response_format, hints.responseFormat);
    assert.equal(blob.type, 'audio/wav');
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveVoice, emptyLlmConfig } from '@tik-choco/mistai/llm-config';
import { synthesizeSpeechApi } from '../src/lib/tts.ts';

const config = emptyLlmConfig();
config.providers = [{ id: 'http', label: 'HTTP', baseUrl: 'https://example.test/v1', apiKey: '' }];
config.tts = { providerId: 'http', model: 'speech-model', voice: 'alloy', speed: 1.75 };
const call = target => synthesizeSpeechApi('Hello', target);

test('HTTP speech uses resolved shared speed and trusts the real response MIME', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response('audio', { headers: { 'Content-Type': 'audio/wav' } });
  });
  const blob = await call(resolveVoice(config, 'tts'));
  assert.equal(body.speed, 1.75);
  assert.equal(body.response_format, 'mp3');
  assert.equal(blob.type, 'audio/wav');
});

test('HTTP speech omits absent and invalid speed hints', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response('audio');
  });
  const target = resolveVoice(config, 'tts');
  for (const speed of [undefined, NaN, Infinity, 0.24, 4.01, '2']) {
    await call({ ...target, speed });
    assert.equal('speed' in body, false);
  }
  for (const speed of [0.25, 4]) {
    await call({ ...target, speed });
    assert.equal(body.speed, speed);
  }
});

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { registerHooks } from 'node:module';

// Node 24 strips TypeScript; resolve the app's extensionless local imports.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) specifier += '.ts';
  return next(specifier, context);
} });
globalThis.window = new EventTarget();
const storage = new Map();
let writes = 0;
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => { writes++; storage.set(key, String(value)); },
};
const { loadSettings, saveSettings, setTtsVoiceOverride, voiceRefKey } = await import('../src/lib/settings.ts');
const { loadLlmConfig, saveLlmConfig } = await import('../src/lib/llmConfig.ts');
const { connectionForTask } = await import('../src/lib/llmConnection.ts');
const { roomOaiUpstream } = await import('@tik-choco/mistai');

function seed() {
  const config = { v: 1, providers: [
    { id: 'http', label: 'HTTP', baseUrl: 'https://example.test/v1', apiKey: '', models: Array.from({ length: 300 }, (_, i) => `m-${i}`) },
    { id: 'disabled', label: 'Disabled', baseUrl: 'https://disabled.test/v1', apiKey: '', enabled: false },
    { id: 'mirror', label: 'Room', baseUrl: 'mist-network://existing', apiKey: '' },
  ], presets: [
    { id: 'default', label: 'Default', providerId: 'http', model: 'm-0', temperature: 0.8, reasoningEffort: 'medium' },
    { id: 'task', label: 'Task', providerId: 'http', model: 'm-42', reasoningEffort: 'xhigh' },
    { id: 'disabled-task', label: 'Disabled task', providerId: 'disabled', model: 'private', reasoningEffort: 'max' },
    { id: 'retired', label: 'Room mirror', providerId: 'mirror', model: 'remote' },
  ], defaultPresetId: 'default', network: { roomId: 'legacy-room' }, tts: { providerId: 'http', model: 'm-10' }, updatedAt: '2026-10-01T00:00:00Z' };
  const local = { targetLanguages: ['Japanese'], activeLanguage: 'Japanese', nativeLanguage: 'English',
    taskPresetIds: { practice: 'task', cards: 'disabled-task', reading: 'retired', generation: 'default' },
    taskReasoningEfforts: { practice: 'none' }, defaultReasoningEffort: 'low',
    networkProviderEnabled: true, networkProviderPresetIds: ['task', 'retired'], ttsVoiceByLanguage: { ja: 'voice-ja' },
    autoExtractCards: false, autoOrganizeCards: false, showReadingAids: false };
  localStorage.setItem('tc-shared-llm-config-v1', JSON.stringify(config));
  localStorage.setItem('tc-lingo:settings-v1', JSON.stringify(local));
  return { config, local };
}
beforeEach(() => { storage.clear(); writes = 0; });

test('migrates shared/local data once, preserving legacy config, effort, languages and cached models', () => {
  const { config } = seed();
  const local = loadSettings();
  const migrated = loadLlmConfig();
  assert.deepEqual(migrated.presets, config.presets);
  assert.deepEqual(migrated.network, config.network);
  assert.equal(migrated.defaultPresetId, config.defaultPresetId);
  assert.deepEqual(migrated.defaultModel, { providerId: 'http', model: 'm-0' });
  assert.equal(migrated.providers[0].models.length, 300);
  assert.equal(migrated.providers[1].enabled, false);
  assert.deepEqual(local.tasks, {
    correction: { ref: { providerId: 'http', model: 'm-42' }, reasoningEffort: 'none' },
    generation: { ref: { providerId: 'disabled', model: 'private' }, reasoningEffort: 'max' },
    'card-organize': { reasoningEffort: 'none' },
  });
  const room = migrated.providers.find(p => p.baseUrl === 'mist-network://legacy-room');
  assert.deepEqual(local.roomProvide[room.id], { enabled: true, shared: [{ providerId: 'http', model: 'm-42' }] });
  assert.equal(local.autoExtractCards, false);
  assert.equal(local.showReadingAids, false);
  assert.deepEqual(local.ttsVoicesByRef[voiceRefKey({ providerId: 'http', model: 'm-10' })], { ja: 'voice-ja' });
  const count = writes;
  loadSettings(); loadLlmConfig(); loadSettings();
  assert.equal(writes, count);
});

test('migrates legacy group settings and uses the first member with values when present', () => {
  const { local } = seed();
  local.taskPresetIds = { generation: 'default' };
  local.taskModels = { conversation: 'm-42' };
  local.taskReasoningEfforts = { correction: 'high' };
  localStorage.setItem('tc-lingo:settings-v1', JSON.stringify(local));

  const { tasks } = loadSettings();
  assert.deepEqual(tasks.correction, { ref: { providerId: 'http', model: 'm-42' }, reasoningEffort: 'high' });
  assert.deepEqual(tasks.generation, { ref: { providerId: 'http', model: 'm-0' }, reasoningEffort: 'medium' });
});

test('moves per-task overrides into missing groups in priority order and saves once', () => {
  const { local } = seed();
  const correction = { ref: { providerId: 'http', model: 'm-42' }, reasoningEffort: 'high' };
  const generation = { ref: { providerId: 'http', model: 'm-30' }, reasoningEffort: 'medium' };
  const embedding = { ref: { providerId: 'http', model: 'm-10' }, reasoningEffort: 'none' };
  const decision = { ref: { providerId: 'http', model: 'm-15' }, reasoningEffort: 'none' };
  local.tasks = { review: correction, conversation: generation, topic: correction, cards: generation,
    reading: correction, grammar: correction, 'ui-translation': correction,
    'card-organize': embedding, decision, future: null };
  local.recentModels = {};
  localStorage.setItem('tc-lingo:settings-v1', JSON.stringify(local));
  const count = writes;

  const expected = { correction, generation, 'card-organize': embedding, decision, future: null };
  assert.deepEqual(loadSettings().tasks, expected);
  assert.deepEqual(loadSettings().recentModels, []);
  assert.deepEqual(JSON.parse(localStorage.getItem('tc-lingo:settings-v1')), { ...local, tasks: expected });
  assert.equal(writes, count + 1);
  for (const task of ['practice', 'review', 'conversation']) {
    assert.equal(connectionForTask(task).target.model, 'm-42');
    assert.equal(connectionForTask(task).target.reasoningEffort, 'high');
  }
  for (const task of ['cards', 'topic', 'reading', 'grammar', 'ui-translation']) {
    assert.equal(connectionForTask(task).target.model, 'm-30');
    assert.equal(connectionForTask(task).target.reasoningEffort, 'medium');
  }
  assert.equal(connectionForTask('card-organize').target.model, 'm-10');
  assert.equal(connectionForTask('decision').target.model, 'm-15');
});

test('keeps an existing group and removes even malformed retired entries', () => {
  const correction = { reasoningEffort: 'low' };
  const tasks = { correction, practice: null, conversation: 'invalid', topic: { reasoningEffort: 'medium' } };
  localStorage.setItem('tc-lingo:settings-v1', JSON.stringify({ tasks }));

  assert.deepEqual(loadSettings().tasks, { correction, generation: tasks.topic });
});

test('disabled or deleted task targets use only a usable default and retain their refs', () => {
  seed(); const local = loadSettings();
  assert.equal(connectionForTask('grammar').target.model, 'm-0');
  const config = loadLlmConfig(); config.providers.find(p => p.id === 'http').enabled = false; saveLlmConfig(config);
  assert.equal(connectionForTask('grammar'), null);
  assert.deepEqual(loadSettings().tasks.generation, local.tasks.generation);
});

test('room refs select their own room regardless of the legacy network room', () => {
  seed(); const local = loadSettings();
  local.tasks.correction = { ref: { providerId: 'mirror', model: 'remote' }, reasoningEffort: 'high' };
  saveSettings(local);
  assert.deepEqual(connectionForTask('practice'), { kind: 'network', roomId: 'existing', model: 'remote', reasoningEffort: 'high' });
});

test('mistai room forwarding retains task effort and removes legacy temperature', () => {
  seed(); loadSettings();
  const resolve = roomOaiUpstream(loadLlmConfig(), [{ providerId: 'http', model: 'm-42' }]);
  const upstream = resolve('/chat/completions', { model: 'm-42' });
  const body = upstream.rewriteBody({ model: 'm-42', stream: true, reasoning_effort: 'xhigh', temperature: 0.8 });
  assert.equal(upstream.baseUrl, 'https://example.test/v1');
  assert.deepEqual(body, { model: 'm-42', stream: false, reasoning_effort: 'xhigh' });
  assert.throws(() => resolve('/chat/completions', { model: 'not-shared' }), /model_not_shared/);
});

test('language voice overrides belong to each exact provider/model ref', () => {
  seed(); loadSettings();
  const a = { providerId: 'http', model: 'm-10' }, b = { providerId: 'http', model: 'm-11' };
  setTtsVoiceOverride(b, 'ja', 'other-voice');
  assert.equal(loadSettings().ttsVoicesByRef[voiceRefKey(a)].ja, 'voice-ja');
  assert.equal(loadSettings().ttsVoicesByRef[voiceRefKey(b)].ja, 'other-voice');
  setTtsVoiceOverride(b, 'ja', '');
  assert.equal(loadSettings().ttsVoicesByRef[voiceRefKey(b)].ja, undefined);
});

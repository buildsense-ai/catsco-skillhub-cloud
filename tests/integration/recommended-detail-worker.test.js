import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processRecommendedDetail, recommendedDetailProvider } from '../../packages/recommended-details/worker.js';

const hash = 'a'.repeat(64);
const version = { id: 'v1', skillId: 'publisher/shorter', version: '1.0.0', visibilityScope: 'public', contentHash: hash };
const file = (path, text) => ({ path, contentBase64: Buffer.from(text).toString('base64') });

test('recommendation worker sends only bounded documentation and keeps only grounded chat prompts', async () => {
  let completion;
  const store = {
    claimRecommendedDetail: async () => ({ ...version, sourceHash: hash, lease: 'lease' }),
    findPublishedVersion: async () => version,
    finishRecommendedDetail: async (_job, result) => { completion = result; }
  };
  const readPackage = async () => ({ files: [
    file('SKILL.md', 'Start with `short mode`; end with `normal mode`.\nAPI key: fake-test-value\nUse the chat command.'),
    file('helper.js', 'process.exit(1)'),
    file('README.md', 'Usage example: `Make this shorter`.')
  ] });
  const generateContent = async (_provider, sources) => {
    assert.deepEqual(sources.map(({ path }) => path), ['SKILL.md', 'README.md']);
    assert.doesNotMatch(sources[0].text, /fake-test-value/);
    return { schemaVersion: 1, summary: '简化回复。', primaryCategory: 'documents', usagePrompts: [
      { label: '启用', prompt: 'short mode' }, { label: '退出', prompt: 'normal mode' },
      { label: '无来源', prompt: 'stop all' }
    ], example: { kind: 'generic', input: 'Unverified example', output: 'Shorter text', copyAsPrompt: true } };
  };
  assert.equal(await processRecommendedDetail({}, store, {}, { readPackage, generateContent }), true);
  assert.deepEqual(completion.content.usagePrompts.map(({ prompt }) => prompt), ['short mode', 'normal mode']);
  assert.equal(completion.content.example.copyAsPrompt, undefined);
  await processRecommendedDetail({}, { ...store, findPublishedVersion: async () => ({ ...version, visibilityScope: 'shared' }) }, {}, {
    readPackage: () => assert.fail('private package must not be read'), generateContent
  });
  assert.deepEqual(completion, { failureCode: 'source_unavailable' });
  await processRecommendedDetail({}, store, {}, { readPackage, generateContent: async () => ({
    schemaVersion: 1, primaryCategory: 'documents', summary: 'Check /root/internal/settings before use.'
  }) });
  assert.deepEqual(completion, { failureCode: 'invalid_detail' });
});

test('detail provider is disabled without a complete HTTPS configuration', () => {
  const settings = { model: 'test-model', apiKey: 'test-credential' };
  assert.equal(recommendedDetailProvider(settings), null);
  assert.equal(recommendedDetailProvider({ ...settings, url: 'http://example.invalid/v1/chat/completions' }), null);
  assert.equal(recommendedDetailProvider({ ...settings, url: 'https://example.invalid/v1/chat/completions' }).model, settings.model);
});

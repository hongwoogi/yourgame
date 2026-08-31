import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutputOnlyArgs, buildProbeArgs, DISABLED_FEATURES, restrictCatalog, sanitizedEnvironment, summarizeRequest, summarizeTools } from '../scripts/probe-codex-output-only.mjs';

test('probe strips secret environment values and never configures a model', () => {
  assert.deepEqual(sanitizedEnvironment({ PATH: 'x', OPENAI_API_KEY: 'fake', TOKEN: 'fake', TURSO_AUTH_TOKEN: 'fake' }), { PATH: 'x' });
  const args = buildProbeArgs({ cwd: 'D:/synthetic', mockBaseUrl: 'http://127.0.0.1:1234/v1' });
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('--strict-config'));
  assert.ok(!args.includes('-m'));
  assert.ok(!args.some((arg) => arg.startsWith('model=')));
  assert.ok(args.some((arg) => arg.includes('requires_openai_auth=false')));
  assert.ok(DISABLED_FEATURES.includes('shell_tool'));
  assert.ok(DISABLED_FEATURES.includes('hooks'));
});

test('catalog removes capabilities without changing model slugs or priority', () => {
  const catalog = { models: [{ slug: 'same-model', priority: 1, tool_mode: 'code_mode', apply_patch_tool_type: 'freeform' }] };
  const restricted = restrictCatalog(catalog);
  assert.equal(restricted.models[0].slug, 'same-model');
  assert.equal(restricted.models[0].priority, 1);
  assert.equal(restricted.models[0].apply_patch_tool_type, null);
  assert.equal(restricted.models[0].tool_mode, 'direct');
  assert.equal(restricted.models[0].multi_agent_version, 'disabled');
  assert.equal(catalog.models[0].tool_mode, 'code_mode');
});

test('missing API tools does not hide prompt-registered tools', () => {
  const body = { model: 'same-model', client_metadata: { 'x-codex-turn-metadata': JSON.stringify({
    tool_namespaces_info: { functions: { functions: { apply_patch: { direct: false } } } },
  }) } };
  assert.equal(summarizeRequest(body).zeroTools, false);
  assert.deepEqual(summarizeRequest(body).registryTools, ['functions.apply_patch']);
  assert.throws(() => summarizeRequest({}), /REGISTRY_METADATA_REQUIRED/);
  assert.throws(() => summarizeRequest({ client_metadata: { 'x-codex-turn-metadata': '{"tool_namespaces_info":{"changedSchema":{}}}' } }), /INVALID_REGISTRY_NAMESPACE/);
});

test('mock refuses external endpoints', () => {
  assert.throws(() => buildProbeArgs({ cwd: 'x', mockBaseUrl: 'https://example.com/v1' }), /MOCK_LOOPBACK_REQUIRED/);
});

test('live args preserve preflight restrictions but not mock routing', () => {
  const args = buildOutputOnlyArgs({ cwd: 'D:/synthetic', catalogPath: 'D:/catalog.json', schemaPath: 'D:/schema.json', finalPath: 'D:/final.json', prompt: 'synthetic' });
  assert.ok(!args.some((arg) => /^(model_provider=|model_providers\.|model=)/.test(arg)));
  assert.ok(args.includes('agents.enabled=false'));
  assert.ok(args.includes('orchestrator.mcp.enabled=false'));
  assert.ok(args.includes('orchestrator.skills.enabled=false'));
  assert.ok(args.includes('tools.experimental_request_user_input.enabled=false'));
  assert.ok(args.includes('--output-schema'));
  assert.ok(args.includes('--output-last-message'));
});

test('tool inventory fails closed on missing or malformed tools', () => {
  assert.throws(() => summarizeTools(), /TOOL_ARRAY_REQUIRED/);
  assert.throws(() => summarizeTools([{}]), /INVALID_TOOL/);
  assert.equal(summarizeTools([]).zeroTools, true);
  const actual = summarizeTools([{ type: 'custom', name: 'apply_patch' }]);
  assert.equal(actual.zeroTools, false);
  assert.equal(actual.toolCount, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { normalizeContext, type SimpleStreamOptions, type Tool } from '@earendil-works/pi-ai';
import {
  NATIVE_RESEARCH_OWNER, NATIVE_RESEARCH_PROTOCOL, NATIVE_RESEARCH_NORMALIZATION,
  NATIVE_RESEARCH_FRAMEWORK_TOOL_HASH, nativeResearchConversation, nativeResearchSystem,
  type NativeResearchAuthority, type NativeResearchBinding, type NativeResearchModelReply,
} from '../src/native-research-contract.ts';
import { canonicalJson, sha256 } from '../src/contracts.ts';
import { nativeExecutionInstrumentation } from '../src/execution-context.ts';
import { NativeResearchBridge } from '../src/research-bridge.ts';
import { parseResearchBinding } from '../src/research-contracts.ts';
import { nativeResearchProvider } from '../src/research-provider.ts';
import { selectResearchOriginal } from '../src/research-wire.ts';

const task = JSON.parse(readFileSync(new URL('./fixtures/flue-2.3.0-task.json', import.meta.url), 'utf8')) as Tool;
async function setup(deadlineMs = Date.now() + 120_000, delayMs = 0) {
  const selector = { owner_id: 'native_owner', project_id: 'native_project', run_id: 'native_run' };
  const basis = {
    version: 'spawn.native-research-binding.v2' as const, selector,
    binding_ref: 'original_research', owner_hash: await sha256('owner'),
    conversation_id: nativeResearchConversation(selector), delivery_key: 'original_delivery',
    protocol: NATIVE_RESEARCH_PROTOCOL, runtime_owner: NATIVE_RESEARCH_OWNER,
    normalization_version: NATIVE_RESEARCH_NORMALIZATION, transport: 'synthetic_native' as const,
    system_instructions: 'Use only supplied source. Date: user instructions keep this exact.',
    message: 'Ledger A dated Wed, Jan 7, 1970 says 12 of 20. Date: never normalize source text.',
    date_label: 'Thu, Jan 1, 1970', max_output_tokens: 2048, deadline_ms: deadlineMs,
  };
  const binding: NativeResearchBinding = { ...basis,
    binding_hash: await sha256(canonicalJson(basis)), wire_sha256: await sha256('retained wire') };
  let calls = 0;
  const reply: NativeResearchModelReply = {
    version: 'spawn.native-research-model-result.v2', binding_hash: binding.binding_hash,
    wire_sha256: binding.wire_sha256, operation_id: 'original_native_effect', provenance: 'synthetic_native',
    output: 'Ledger A reports 12 of 20 (60%).', output_hash: await sha256('Ledger A reports 12 of 20 (60%).'),
    capture_hash: await sha256('native capture'), input_tokens: 100, output_tokens: 20, accounting: 'settled',
  };
  const native: NativeResearchAuthority = {
    resolve: async () => binding, resolveConversation: async () => binding,
    prepare: async () => {}, admitted: async () => {}, admission: async () => null,
    stop: async () => {}, executeModel: async () => {
      calls++;
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      return structuredClone(reply);
    },
  };
  const provider = nativeResearchProvider(() => native), model = provider.getModels()[0];
  const context = (tools: Tool[] = [structuredClone(task)]) => normalizeContext({
    systemPrompt: nativeResearchSystem(binding.system_instructions, 'Thu, Nov 12, 2026'), tools,
    messages: [{ role: 'user', content: binding.message, timestamp: 0 }],
  });
  const instrumentation = nativeExecutionInstrumentation();
  const invoke = (input = context(), options?: SimpleStreamOptions) => instrumentation.interceptor(
    { type: 'model', turnId: 'transient_flue_turn' }, { instanceId: binding.conversation_id },
    () => provider.streamSimple(model, input, options ?? {}).result());
  return { binding, native, provider, model, context, invoke, reply, calls: () => calls };
}

test('research normalization pins the exact released task declaration and only replaces the framework date', async () => {
  const f = await setup();
  assert.equal(await sha256(canonicalJson(task)), NATIVE_RESEARCH_FRAMEWORK_TOOL_HASH);
  const original = await selectResearchOriginal(f.binding, 'root', f.model, f.context());
  assert.deepEqual(original, { selector: f.binding.selector, binding_ref: f.binding.binding_ref,
    binding_hash: f.binding.binding_hash, wire_sha256: f.binding.wire_sha256 });
  const changedUser = f.context();
  changedUser.messages.push({ role: 'user', content: 'A second call', timestamp: 1 });
  await assert.rejects(selectResearchOriginal(f.binding, 'root', f.model, changedUser), /SINGLE_CALL_REQUIRED/);
  const changedSystem = normalizeContext({ systemPrompt: nativeResearchSystem('Changed instructions', f.binding.date_label),
    tools: [task], messages: [{ role: 'user', content: f.binding.message, timestamp: 0 }] });
  await assert.rejects(selectResearchOriginal(f.binding, 'root', f.model, changedSystem), /SYSTEM_CHANGED/);
  const changedSource = normalizeContext({ systemPrompt: nativeResearchSystem(f.binding.system_instructions, f.binding.date_label),
    tools: [task], messages: [{ role: 'user', content: f.binding.message.replace('Jan 7', 'Jan 1'), timestamp: 0 }] });
  await assert.rejects(selectResearchOriginal(f.binding, 'root', f.model, changedSource), /INPUT_CHANGED/);
});

for (const mutation of ['missing', 'extra', 'renamed', 'description', 'schema', 'extra-field', 'task-shaped-custom'] as const)
  test(`research rejects ${mutation} tool declaration before the native effect`, async () => {
    const f = await setup(), changed = structuredClone(task);
    let tools: Tool[] = [changed];
    if (mutation === 'missing') tools = [];
    if (mutation === 'extra') tools.push({ ...structuredClone(task), name: 'additional_tool' });
    if (mutation === 'renamed') changed.name = 'renamed_task';
    if (mutation === 'description') changed.description += ' injected';
    if (mutation === 'schema') changed.parameters = { ...changed.parameters, additionalProperties: true };
    if (mutation === 'extra-field') Object.assign(changed, { custom: true });
    if (mutation === 'task-shaped-custom') tools.push({ ...structuredClone(task), name: 'native_research_task' });
    const result = await f.invoke(f.context(tools));
    assert.equal(result.stopReason, 'error');
    assert.equal(result.errorMessage, 'NATIVE_RESEARCH_TOOL_NOT_QUALIFIED');
    assert.equal(f.calls(), 0);
  });

test('research returns only the original native candidate and factual capture identity', async () => {
  const f = await setup();
  const result = await f.invoke();
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(result.content, [{ type: 'text', text: f.reply.output }]);
  assert.equal(result.responseId, f.reply.operation_id);
  assert.equal(f.calls(), 1);
  f.native.executeModel = async () => ({ ...f.reply, output: 'changed after capture' });
  const changed = await f.invoke();
  assert.equal(changed.stopReason, 'error');
  assert.equal(changed.errorMessage, 'NATIVE_RESEARCH_ORIGINAL_CHANGED');
});

test('research refuses provider overrides and subordinate or compaction call sites', async () => {
  const f = await setup();
  for (const options of [{ apiKey: 'forbidden' }, { maxTokens: 1 }, { temperature: 0 }, { toolChoice: 'auto' }]) {
    await assert.rejects(selectResearchOriginal(f.binding, 'root', f.model, f.context(), options as SimpleStreamOptions), /OVERRIDE_NOT_QUALIFIED/);
  }
  for (const callSite of ['root/tool:task:one', 'root/summary:0'])
    await assert.rejects(selectResearchOriginal(f.binding, callSite, f.model, f.context()), /MODEL_NOT_QUALIFIED/);
  assert.equal(f.calls(), 0);
});

test('research binding cannot change version, scope or serialized input under the original hash', async () => {
  const f = await setup();
  assert.deepEqual(await parseResearchBinding(f.binding), f.binding);
  for (const changed of [{ ...f.binding, message: 'replacement' }, { ...f.binding, transport: 'live' },
    { ...f.binding, protocol: 'spawn.openrouter-flue-chat.v1' },
    { ...f.binding, selector: { ...f.binding.selector, run_id: 'foreign' } }])
    await assert.rejects(parseResearchBinding(changed));
});

test('research bridge records the exact original idempotency key and awaits native reverse execution before admission ACK', async () => {
  const f = await setup();
  const events: string[] = [];
  f.native.prepare = async () => { events.push('intent'); };
  f.native.admitted = async () => { events.push('admitted'); };
  const receipt = { submissionId: 'original_submission', acceptedAt: '2026-11-12T00:00:00.000Z', uid: 'original_uid' };
  const bridge = new NativeResearchBridge(f.native, id => {
    assert.equal(id, f.binding.conversation_id);
    return {
      dispatch: async input => {
        assert.equal(input.idempotencyKey, f.binding.delivery_key);
        assert.equal(input.message, f.binding.message);
        events.push('dispatch');
        const result = await f.invoke();
        assert.equal(result.stopReason, 'stop');
        events.push('native-result');
        return receipt;
      },
      read: async () => ({ text: f.reply.output }), abort: async () => {},
    };
  });
  assert.deepEqual(await bridge.send(f.binding.selector), receipt);
  assert.deepEqual(events, ['intent', 'dispatch', 'native-result', 'admitted']);
  assert.equal(f.calls(), 1);
});

test('an expired research deadline refuses the native model call before admission', async () => {
  const f = await setup(Date.now() - 1);
  const result = await f.invoke();
  assert.equal(result.stopReason, 'error');
  assert.equal(result.errorMessage, 'NATIVE_RESEARCH_DEADLINE_EXCEEDED');
  assert.equal(f.calls(), 0);
});

test('a research deadline crossed during the native call rejects delivery of the output', async () => {
  const f = await setup(Date.now() + 50, 300);
  const result = await f.invoke();
  assert.equal(result.stopReason, 'error');
  assert.equal(result.errorMessage, 'NATIVE_RESEARCH_DEADLINE_EXCEEDED');
  assert.equal(f.calls(), 1);
  assert.deepEqual(result.content, []);
});

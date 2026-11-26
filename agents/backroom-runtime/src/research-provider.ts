import * as v from 'valibot';
import { createAssistantMessageEventStream, createProvider,
  type AssistantMessage, type Provider, type ProviderStreams } from '@earendil-works/pi-ai';
import { NATIVE_RESEARCH_MODEL, NATIVE_RESEARCH_PROTOCOL, NATIVE_RESEARCH_PROVIDER,
  type NativeResearchAuthority } from './native-research-contract.ts';
import { requireCondition, sha256 } from './contracts.ts';
import { nativeExecutionContext } from './execution-context.ts';
import { parseResearchBinding, researchReplySchema } from './research-contracts.ts';
import { selectResearchOriginal } from './research-wire.ts';

export function nativeResearchProvider(authority: () => NativeResearchAuthority): Provider {
  const stream: ProviderStreams['stream'] = (model, context, options) => {
    const output = createAssistantMessageEventStream(), execution = nativeExecutionContext();
    void (async () => {
      const native = authority(), instance = execution.flue.eventContext?.id ?? execution.flue.instanceId;
      requireCondition(instance, 'NATIVE_RESEARCH_CONTEXT_REQUIRED');
      const binding = await parseResearchBinding(await native.resolveConversation(instance));
      requireCondition(binding.conversation_id === instance, 'NATIVE_RESEARCH_CONTEXT_CHANGED');
      const original = await selectResearchOriginal(binding, execution.callSite, model, context, options);
      requireCondition(!options?.signal?.aborted, 'NATIVE_RESEARCH_ABORTED');
      requireCondition(Date.now() < binding.deadline_ms, 'NATIVE_RESEARCH_DEADLINE_EXCEEDED');
      const result = v.parse(researchReplySchema, await native.executeModel(original));
      requireCondition(result.binding_hash === binding.binding_hash && result.wire_sha256 === binding.wire_sha256 &&
        result.output_hash === await sha256(result.output), 'NATIVE_RESEARCH_ORIGINAL_CHANGED');
      requireCondition(!options?.signal?.aborted, 'NATIVE_RESEARCH_ABORTED');
      requireCondition(Date.now() < binding.deadline_ms, 'NATIVE_RESEARCH_DEADLINE_EXCEEDED');
      const message: AssistantMessage = {
        role: 'assistant', content: [{ type: 'text', text: result.output }],
        api: NATIVE_RESEARCH_PROTOCOL, provider: NATIVE_RESEARCH_PROVIDER, model: model.id,
        responseId: result.operation_id, stopReason: 'stop', timestamp: 0,
        usage: { input: result.input_tokens, output: result.output_tokens,
          cacheRead: 0, cacheWrite: 0, totalTokens: result.input_tokens + result.output_tokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      output.push({ type: 'start', partial: message });
      output.push({ type: 'text_start', contentIndex: 0, partial: message });
      output.push({ type: 'text_delta', contentIndex: 0, delta: result.output, partial: message });
      output.push({ type: 'text_end', contentIndex: 0, content: result.output, partial: message });
      output.push({ type: 'done', reason: 'stop', message });
    })().catch(error => {
      const code = error instanceof Error && /^NATIVE_[A-Z_]+$/.test(error.message)
        ? error.message : 'NATIVE_RESEARCH_PROVIDER_FAILED';
      const reason = code === 'NATIVE_RESEARCH_ABORTED' ? 'aborted' : 'error';
      const message: AssistantMessage = {
        role: 'assistant', content: [], api: NATIVE_RESEARCH_PROTOCOL,
        provider: NATIVE_RESEARCH_PROVIDER, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: reason, errorMessage: code, timestamp: 0,
      };
      output.push({ type: 'error', reason, error: message });
    });
    return output;
  };
  return createProvider({
    id: NATIVE_RESEARCH_PROVIDER,
    auth: { apiKey: { name: 'Native research authority binding', resolve: async () => ({ auth: {} }) } },
    models: [{ id: NATIVE_RESEARCH_MODEL, name: NATIVE_RESEARCH_MODEL,
      api: NATIVE_RESEARCH_PROTOCOL, provider: NATIVE_RESEARCH_PROVIDER, baseUrl: 'https://native.invalid',
      reasoning: false, input: ['text'], contextWindow: 131_072, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    api: { stream, streamSimple: stream },
  });
}

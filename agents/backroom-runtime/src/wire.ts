import {
  getCurrentSystemPrompt, getCurrentTools,
  type Api, type AssistantMessage, type Model, type SimpleStreamOptions, type TranscriptContext,
} from '@earendil-works/pi-ai';
import {
  MAX_RESPONSE_BYTES, MAX_WIRE_BYTES, MODEL_ID, PROVIDER_ID, SUMMARY_MODEL_ID,
  WIRE_PROTOCOL, canonicalJson, requireCondition, sha256,
  type NativeModelRequest, type NativeWorkBinding,
} from './contracts.ts';

function textContent(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content;
  requireCondition(content.every(part => part.type === 'text' && typeof part.text === 'string'),
    'NATIVE_TEXT_CONTENT_REQUIRED');
  return content.map(part => part.text).join('\n');
}

// Provider bodies and tool arguments are untrusted wire data. A malformed JSON
// payload must fail with the same contract error as any other invalid response,
// not surface a raw SyntaxError that bypasses the native failure taxonomy.
function parseWireJson(text: string, code: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(code);
  }
}

export async function prepareModelRequest(binding: NativeWorkBinding, bindingHash: string,
  callSite: string, model: Model<Api>, context: TranscriptContext,
  options?: SimpleStreamOptions): Promise<NativeModelRequest> {
  requireCondition(model.provider === PROVIDER_ID && model.api === WIRE_PROTOCOL &&
    [MODEL_ID, SUMMARY_MODEL_ID].includes(model.id as typeof MODEL_ID),
    'NATIVE_MODEL_NOT_QUALIFIED');
  requireCondition(!options?.apiKey && !options?.fetch && !options?.env && !options?.headers &&
    !options?.onPayload && !options?.onResponse && !options?.samplingParams && !options?.reasoning &&
    !options?.deferred, 'NATIVE_PROVIDER_OVERRIDE_NOT_QUALIFIED');
  requireCondition(options?.maxTokens === undefined ||
    (Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0), 'NATIVE_TOKEN_LIMIT_INVALID');
  requireCondition(options?.temperature === undefined ||
    (Number.isFinite(options.temperature) && options.temperature >= 0 && options.temperature <= 2),
  'NATIVE_TEMPERATURE_INVALID');
  const system = getCurrentSystemPrompt(context.messages);
  const messages: unknown[] = system ? [{ role: 'system', content: system }] : [];
  for (const message of context.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') messages.push({ role: 'user', content: textContent(message.content) });
    else if (message.role === 'toolResult') messages.push({ role: 'tool', tool_call_id: message.toolCallId,
      content: textContent(message.content) });
    else {
      requireCondition(message.content.every(part => part.type === 'text' || part.type === 'toolCall'),
        'NATIVE_REASONING_REPLAY_NOT_QUALIFIED');
      const calls = message.content.filter(part => part.type === 'toolCall');
      messages.push({ role: 'assistant', content: message.content.filter(part => part.type === 'text')
        .map(part => part.text).join('\n') || null,
      ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function',
        function: { name: call.name, arguments: canonicalJson(call.arguments) } })) } : {}) });
    }
  }
  const tools = getCurrentTools(context.messages).map(tool => ({ type: 'function', function: {
    name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)),
  } }));
  const wireText = canonicalJson({ model: model.id, messages,
    max_tokens: Math.min(binding.max_output_tokens, options?.maxTokens ?? binding.max_output_tokens),
    ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options?.toolChoice === undefined ? {} : { tool_choice: options.toolChoice }),
    stream: false, ...(tools.length ? { tools } : {}),
    provider: { allow_fallbacks: false },
  });
  const wireBytes = new TextEncoder().encode(wireText).byteLength;
  requireCondition(wireBytes <= MAX_WIRE_BYTES, 'NATIVE_REQUEST_TOO_LARGE');
  const wireHash = await sha256(wireText);
  const purpose = model.id === SUMMARY_MODEL_ID ? 'compaction' : 'agent';
  const semanticSite = `${callSite}/${purpose}`;
  return {
    protocol: WIRE_PROTOCOL, binding_ref: binding.binding_ref, binding_hash: bindingHash,
    work_id: binding.work_id, command_id: binding.command_id, call_site: semanticSite,
    request_key: await sha256(canonicalJson({ work: binding.work_id, command: binding.command_id,
      actor: binding.actor_id, call_site: semanticSite, wire_sha256: wireHash })),
    wire_text: wireText, wire_sha256: wireHash, wire_bytes: wireBytes, deadline_ms: binding.deadline_ms,
  };
}

export function assistantFromResponse(rawText: string, model: Model<Api>, httpStatus = 200): AssistantMessage {
  requireCondition(new TextEncoder().encode(rawText).byteLength <= MAX_RESPONSE_BYTES, 'NATIVE_RESPONSE_TOO_LARGE');
  const raw = parseWireJson(rawText, 'NATIVE_RESPONSE_INVALID');
  if (httpStatus === 400 && raw?.error?.code === 'context_length_exceeded') {
    return { role: 'assistant', content: [], api: WIRE_PROTOCOL, provider: PROVIDER_ID, model: model.id,
      responseId: raw.id, stopReason: 'error',
      errorMessage: `NATIVE_CONTEXT_LENGTH_EXCEEDED: maximum context length is ${model.contextWindow} tokens`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 };
  }
  requireCondition(httpStatus >= 200 && httpStatus < 300, 'NATIVE_PROVIDER_REJECTED');
  requireCondition(raw && typeof raw === 'object' && typeof raw.id === 'string' &&
    raw.model === model.id && Array.isArray(raw.choices) && raw.choices.length === 1,
    'NATIVE_RESPONSE_INVALID');
  const choice = raw.choices[0];
  const value = choice.message;
  requireCondition(value && value.role === 'assistant' &&
    (value.content === null || typeof value.content === 'string'), 'NATIVE_RESPONSE_INVALID');
  const content: AssistantMessage['content'] = value.content ? [{ type: 'text', text: value.content }] : [];
  if (value.tool_calls !== undefined) {
    requireCondition(Array.isArray(value.tool_calls) && value.tool_calls.length <= 8, 'NATIVE_TOOL_CALLS_INVALID');
    const ids = new Set<string>();
    for (const call of value.tool_calls) {
      requireCondition(call?.type === 'function' && typeof call.id === 'string' &&
        typeof call.function?.name === 'string' && typeof call.function.arguments === 'string',
        'NATIVE_TOOL_CALL_INVALID');
      requireCondition(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(call.id) && !ids.has(call.id),
        'NATIVE_TOOL_CALL_ID_INVALID');
      ids.add(call.id);
      requireCondition(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(call.function.name), 'NATIVE_TOOL_NAME_INVALID');
      const args = parseWireJson(call.function.arguments, 'NATIVE_TOOL_ARGUMENTS_INVALID');
      requireCondition(args && typeof args === 'object' && !Array.isArray(args), 'NATIVE_TOOL_ARGUMENTS_INVALID');
      content.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: args });
    }
  }
  requireCondition(['stop', 'length', 'tool_calls'].includes(choice.finish_reason), 'NATIVE_FINISH_REASON_INVALID');
  requireCondition((choice.finish_reason === 'tool_calls') === content.some(part => part.type === 'toolCall'),
    'NATIVE_FINISH_REASON_MISMATCH');
  requireCondition(raw.usage && ['prompt_tokens', 'completion_tokens'].every(key =>
    Number.isSafeInteger(raw.usage[key]) && raw.usage[key] >= 0), 'NATIVE_USAGE_REQUIRED');
  return {
    role: 'assistant', content, api: WIRE_PROTOCOL, provider: PROVIDER_ID, model: model.id,
    responseId: raw.id, stopReason: choice.finish_reason === 'tool_calls' ? 'toolUse' : choice.finish_reason,
    usage: { input: raw.usage.prompt_tokens, output: raw.usage.completion_tokens,
      cacheRead: 0, cacheWrite: 0, totalTokens: raw.usage.prompt_tokens + raw.usage.completion_tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 0,
  };
}

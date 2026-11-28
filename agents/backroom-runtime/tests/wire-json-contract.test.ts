import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantFromResponse } from '../src/wire.ts';

const model = { id: 'native_model', contextWindow: 4096 } as never;

test('malformed provider JSON fails with the native response contract', () => {
  assert.throws(() => assistantFromResponse('{not json', model), /NATIVE_RESPONSE_INVALID/);
});

test('malformed tool-call arguments fail with the tool argument contract', () => {
  const response = JSON.stringify({
    id: 'provider_original', model: 'native_model',
    choices: [{ message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function',
        function: { name: 'native_summarize_v1', arguments: '{oops' } }],
    }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  assert.throws(() => assistantFromResponse(response, model), /NATIVE_TOOL_ARGUMENTS_INVALID/);
});

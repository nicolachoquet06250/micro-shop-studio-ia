import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const reasoningUrl = moduleUrl(await readFile(new URL('../src/lib/reasoning.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../src/lib/openai.ts', import.meta.url), 'utf8');
const { chatCompletion } = await import(moduleUrl(source.replace("'./reasoning'", JSON.stringify(reasoningUrl))));
const settings = { model: 'test', baseUrl: 'http://test', apiKey: '', reasoningStrategy: 'prompt' };
const messages = [{ role: 'user', content: 'Generate the response' }];

test('negotiates token limit names in both directions and preserves the value', async (t) => {
  const requests = [];
  let accepted = 'max_completion_tokens';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const payload = JSON.parse(init.body).payload;
    requests.push(payload);
    const rejected = accepted === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
    if (Object.hasOwn(payload, rejected)) {
      return Response.json({ error: { message: `Unsupported parameter: '${rejected}'. Use '${accepted}' instead.` } }, { status: 400 });
    }
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  });
  const configured = { ...settings, model: 'token-negotiation' };
  await chatCompletion(configured, messages, { maxTokens: 12000 });
  assert.equal(requests[0].max_tokens, 12000);
  assert.equal(requests[1].max_completion_tokens, 12000);
  assert.equal(requests[1].max_tokens, undefined);
  await chatCompletion(configured, messages, { maxTokens: 8000 });
  assert.equal(requests[2].max_completion_tokens, 8000);
  accepted = 'max_tokens';
  await chatCompletion(configured, messages, { maxTokens: 4000 });
  assert.equal(requests[3].max_completion_tokens, 4000);
  assert.equal(requests[4].max_tokens, 4000);
  assert.equal(requests[4].max_completion_tokens, undefined);
  await chatCompletion(configured, messages);
  assert.equal(requests[5].max_tokens, undefined);
  assert.equal(requests[5].max_completion_tokens, undefined);
});

test('does not swap token parameters on unrelated errors', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({ error: { message: 'max_tokens exceeds model limit' } }, { status: 400 });
  });
  await assert.rejects(chatCompletion(settings, messages, { maxTokens: 999999 }), /exceeds model limit/);
  assert.equal(calls, 1);
});

function mockResponses(t, fragments, sse = false) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body).payload);
    const [content, finish_reason] = fragments.shift() ?? ['x', 'length'];
    const payload = sse
      ? `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ choices: [{ message: { content }, finish_reason }] });
    return new Response(payload, { headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' } });
  });
  return requests;
}

test('reassembles JSON across multiple cutoffs and disables JSON mode for suffixes', async (t) => {
  const requests = mockResponses(t, [['{"name":"hel', 'length'], ['lo","ok":', 'length'], ['true}', 'stop']]);
  const streamed = [];
  const traces = [];
  const result = await chatCompletion(settings, messages, { json: true, onDelta: (_delta, text) => streamed.push(text), onTrace: (event) => traces.push(event) });
  assert.deepEqual(JSON.parse(result.content), { name: 'hello', ok: true });
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.equal(requests[1].response_format, undefined);
  assert.equal(streamed.at(-1), result.content);
  assert.equal(traces.at(-1).trace.output, result.content);
  assert.equal(traces.at(-1).trace.json, true);
  assert.equal(traces.filter((event) => event.type === 'streaming').length, 3);
});

test('publishes short reasoning chunks immediately before final content', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    const chunks = [
      { reasoning_content: 'First thought. ' },
      { reasoning_content: 'Second thought.' },
      { content: '{"ok":true}' },
    ];
    const body = chunks.map((delta, index) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: index === 2 ? 'stop' : null }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  const traces = [];
  await chatCompletion(settings, messages, { json: true, onTrace: (event) => traces.push(event) });
  const streaming = traces.filter((event) => event.type === 'streaming');
  assert.equal(streaming[0].trace.reasoning, 'First thought. ');
  assert.equal(streaming[0].trace.output, '');
  assert.equal(streaming[1].trace.reasoning, 'First thought. Second thought.');
  assert.equal(streaming[1].trace.hadReasoning, true);
});

test('SSE continuation removes repeated tail at the join', async (t) => {
  const tail = 'abcdefghijklmnopqrstuvwxyz';
  mockResponses(t, [[`prefix ${tail}`, 'length'], [`${tail} suffix`, 'stop']], true);
  const result = await chatCompletion(settings, messages);
  assert.equal(result.content, `prefix ${tail} suffix`);
});

test('file callers can retain their own continuation loop', async (t) => {
  const requests = mockResponses(t, [['partial', 'length']]);
  const result = await chatCompletion(settings, messages, { continueOnLength: false });
  assert.equal(result.finishReason, 'length');
  assert.equal(requests.length, 1);
});

test('rejects malformed assembled JSON', async (t) => {
  mockResponses(t, [['{"a":', 'length'], ['oops}', 'stop']]);
  await assert.rejects(chatCompletion(settings, messages, { json: true }));
});

test('bounds repeated truncation to twelve fragments', async (t) => {
  const requests = mockResponses(t, []);
  await assert.rejects(chatCompletion(settings, messages), /12 fragments/);
  assert.equal(requests.length, 12);
});

test('honors cancellation before another request', async (t) => {
  const requests = mockResponses(t, [['partial', 'length']]);
  const controller = new AbortController();
  await assert.rejects(chatCompletion(settings, messages, {
    signal: controller.signal,
    onDelta: () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(requests.length, 1);
});

test('rejects continuation that only repeats the preceding tail', async (t) => {
  const tail = 'abcdefghijklmnopqrstuvwxyz';
  mockResponses(t, [[tail, 'length'], [tail, 'length']]);
  await assert.rejects(chatCompletion(settings, messages), /sans progression/);
});

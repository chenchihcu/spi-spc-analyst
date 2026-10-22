// Cloudflare /api/analyze 的模型選擇與送出參數：攔截 fetch，檢查實際送往 AI Gateway 的請求，不呼叫真模型、不產生費用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAnalyze, DEFAULT_MODEL, MAX_TOKENS } from '../cloudflare/ai.mjs';

const ENV = { CF_ACCOUNT_ID: 'acc', CF_AI_GATEWAY_ID: 'gw', CF_AI_GATEWAY_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key' };
const BODY = JSON.stringify({ payload: { 系統偵測問題清單: [{ 問題: '體積偏低', 事實: ['平均 82%'] }] } });

// 最小的 Messages API 串流回應：一段文字後正常結束
const sse = (model, text, stopReason = 'end_turn') => [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join('');

async function postWithCapture(env, stopReason) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const sent = JSON.parse(init.body);
    calls.push({ url: String(url), body: sent });
    return new Response(sse(sent.model, '分析結果', stopReason), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const res = await handleAnalyze(new Request('https://spi.example/api/analyze', { method: 'POST', body: BODY }), env);
    return { res, text: await res.text(), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('AI 預設模型為現行 claude-opus-5-5，GET 健康檢查回報同一模型', async () => {
  assert.equal(DEFAULT_MODEL, 'claude-opus-5-5');
  const res = await handleAnalyze(new Request('https://spi.example/api/analyze'), ENV);
  assert.equal((await res.json()).model, 'claude-opus-5-5');
});

test('未設 AI_MODEL 時，送往 AI Gateway 的請求使用預設模型與足夠的 max_tokens', async () => {
  const { res, text, calls } = await postWithCapture(ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-AI-Model'), 'claude-opus-5-5');
  assert.equal(text, '分析結果');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/acc\/gw\/anthropic\/v1\/messages/);
  assert.equal(calls[0].body.model, 'claude-opus-5-5');
  assert.equal(calls[0].body.stream, true);
  // 思考無法關閉且占用 max_tokens：上限需遠高於回覆本身（約 2000 tokens）
  assert.equal(calls[0].body.max_tokens, MAX_TOKENS);
  assert.ok(MAX_TOKENS >= 16000, `max_tokens 過低會截斷回覆，實為 ${MAX_TOKENS}`);
  assert.equal(calls[0].body.thinking, undefined, '不送 thinking 參數（opus-5-5 送 disabled 會 400）');
});

test('AI_MODEL 環境變數仍可覆寫預設模型', async () => {
  const { res, calls } = await postWithCapture({ ...ENV, AI_MODEL: 'claude-sonnet-5-5' });
  assert.equal(res.headers.get('X-AI-Model'), 'claude-sonnet-5-5');
  assert.equal(calls[0].body.model, 'claude-sonnet-5-5');
});

test('回覆達 max_tokens 上限時仍附加截斷提示', async () => {
  const { text } = await postWithCapture(ENV, 'max_tokens');
  assert.match(text, /回覆已達長度上限/);
});

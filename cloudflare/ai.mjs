import Anthropic from '@anthropic-ai/sdk';
import { validatePayload, buildMessages, SYSTEM_PROMPT, InputError } from '../lib/analyze-core.mjs';

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } });

export async function handleAnalyze(req, env) {
  if (env && env.AI_ENABLED === 'false') {
    return json({ error: '管理員已停用 AI 分析功能' }, 403);
  }
  const model = env.AI_MODEL || 'claude-3-5-sonnet-latest';
  const gateway = Boolean(env.CF_ACCOUNT_ID && env.CF_AI_GATEWAY_ID && env.CF_AI_GATEWAY_TOKEN && (env.ANTHROPIC_API_KEY || env.CF_AI_BYOK === 'true'));
  const logPayload = env.AI_LOG_PAYLOAD === 'true';
  if (req.method === 'GET') return json({ ok: true, gateway, model, logPayload });
  if (req.method !== 'POST') return json({ error: '只接受 GET 或 POST' }, 405);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return json({ error: '不接受其他網站的請求' }, 403);
  if (!gateway) return json({ error: 'Cloudflare AI Gateway 尚未設定' }, 503);

  let payload;
  try { payload = validatePayload(await req.text()); }
  catch (e) { if (e instanceof InputError) return json({ error: e.message }, 400); throw e; }

  const defaultHeaders = env.CF_AI_BYOK === 'true'
    ? { Authorization: `Bearer ${env.CF_AI_GATEWAY_TOKEN}` }
    : { 'cf-aig-authorization': `Bearer ${env.CF_AI_GATEWAY_TOKEN}` };

  if (!logPayload) {
    defaultHeaders['cf-aig-collect-log-payload'] = 'false';
  }

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY || 'placeholder',
    baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY_ID}/anthropic`,
    defaultHeaders,
  });
  const stream = client.messages.stream({ model, max_tokens: 2000, system: SYSTEM_PROMPT, messages: buildMessages(payload) });
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of stream) if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') controller.enqueue(enc.encode(ev.delta.text));
        const final = await stream.finalMessage();
        if (final.stop_reason === 'max_tokens') controller.enqueue(enc.encode('\n\n（回覆已達長度上限，內容可能不完整）'));
      } catch (e) {
        controller.enqueue(enc.encode(`\n\n［AI 分析失敗：${e?.status ? e.status + ' ' : ''}${e?.message || e}］`));
      } finally { controller.close(); }
    },
    cancel() { stream.abort(); },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-AI-Model': model } });
}

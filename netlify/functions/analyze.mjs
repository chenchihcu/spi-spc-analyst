// POST /api/analyze：把統計摘要與問題清單交給 Claude 審查，串流回傳純文字（Markdown）
// GET  /api/analyze：健康檢查，只回報 AI Gateway 是否啟用，不呼叫模型、不產生費用
//
// 憑證由 Netlify AI Gateway 在執行期注入（ANTHROPIC_API_KEY／ANTHROPIC_BASE_URL），程式內沒有任何金鑰。
// 模型可用環境變數 AI_MODEL 覆寫；預設值取自 AI Gateway 的可用模型清單。
import Anthropic from "@anthropic-ai/sdk";
import { validatePayload, buildMessages, SYSTEM_PROMPT, InputError } from "../../lib/analyze-core.mjs";

const MODEL = process.env.AI_MODEL || "claude-sonnet-5-5";
const MAX_TOKENS = 2000;

const json = (obj, status = 200) => Response.json(obj, { status, headers: { "Cache-Control": "no-store" } });

export default async (req) => {
  const gateway = Boolean(process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_KEY);

  if (req.method === "GET") return json({ ok: true, gateway, model: MODEL });
  if (req.method !== "POST") return json({ error: "只接受 GET 或 POST" }, 405);

  // 只接受同一網站發出的請求（瀏覽器會自動帶 Origin）
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return json({ error: "不接受其他網站的請求" }, 403);

  if (!gateway) return json({ error: "AI Gateway 尚未啟用：請確認網站已有正式部署，且團隊未停用 AI 功能" }, 503);

  let payload;
  try {
    payload = validatePayload(await req.text());
  } catch (e) {
    if (e instanceof InputError) return json({ error: e.message }, 400);
    throw e;
  }

  const client = new Anthropic();
  const stream = client.messages.stream({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: buildMessages(payload) });

  // 串流逐段回傳文字，避免長回覆碰到函式 60 秒逾時
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of stream) {
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") controller.enqueue(enc.encode(ev.delta.text));
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === "max_tokens") controller.enqueue(enc.encode("\n\n（回覆已達長度上限，內容可能不完整）"));
      } catch (e) {
        controller.enqueue(enc.encode(`\n\n［AI 分析失敗：${e?.status ? e.status + " " : ""}${e?.message || e}］`));
      } finally {
        controller.close();
      }
    },
    cancel() { stream.abort(); },
  });

  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-AI-Model": MODEL } });
};

export const config = { path: "/api/analyze" };

/*
 * 定制新闻台 — Cloudflare Worker (thin proxy + voice)
 * Serves the phone app and the news data straight from the GitHub repo
 * nighteamxy-hue/nouve-news-data. Claude's scheduled task pushes fresh
 * news to that repo every 6 hours.
 *
 * /api/audio turns one news item into a Chinese MP3 with Workers AI (MeloTTS),
 * so the phone can keep playing with the screen off or in another app.
 *
 * Bindings: NEWS_KV (KV — source-list edits and cached audio)
 *           AI (Workers AI — text to speech)
 *           ADMIN_TOKEN (secret, optional — needed only to edit sources)
 */
const RAW = "https://raw.githubusercontent.com/nighteamxy-hue/nouve-news-data/main/";
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8", 60],
  "/index.html": ["index.html", "text/html; charset=utf-8", 60],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8", 3600],
  "/icon-180.png": ["icon-180.png", "image/png", 86400],
  "/icon-512.png": ["icon-512.png", "image/png", 86400],
};
const CATS = ["ai", "econ", "stock", "tech", "robot", "ent", "travel", "general"];
const AUDIO_VERSION = "v1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (request.method === "GET" && STATIC[p]) {
        const [file, type, ttl] = STATIC[p];
        const r = await gh(file, ttl);
        if (!r.ok) return new Response("Not found", { status: 404 });
        return new Response(r.body, { headers: { "content-type": type, "cache-control": `public, max-age=${Math.min(ttl, 300)}` } });
      }
      if (request.method === "GET" && p === "/api/news") {
        const [newsR, meta, sources] = await Promise.all([gh("data/news.json", 60), ghJSON("data/meta.json", {}), loadSources(env)]);
        const newsText = newsR.ok ? await newsR.text() : "[]";
        const body = `{"news":${newsText},"sources":${JSON.stringify(sources)},"meta":${JSON.stringify({ ...meta, voice: !!env.AI })}}`;
        return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      }
      if (request.method === "GET" && p === "/api/audio") return audio(request, env, ctx, url);
      if (request.method === "GET" && p === "/api/sources") return json(await loadSources(env));
      if (p === "/api/check") return authorized(request, env) ? json({ ok: true }) : json({ error: "unauthorized" }, 401);
      if (request.method === "POST" && p === "/api/sources") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
        const body = await request.json().catch(() => ({}));
        const sources = await loadSources(env);
        let next = sources;
        if (body.action === "add") {
          const name = String(body.name || "").trim().slice(0, 60);
          const u = String(body.url || "").trim();
          if (!name || !/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(u)) return json({ error: "bad_input" }, 400);
          if (sources.some(s => s.url === u)) return json({ error: "duplicate" }, 409);
          next = [...sources, { id: "u-" + Date.now().toString(36), name, url: u, region: "", category: CATS.includes(body.category) ? body.category : "general", enabled: true, builtin: false }];
        } else if (body.action === "delete") {
          next = sources.filter(s => s.id !== body.id);
        } else if (body.action === "toggle") {
          next = sources.map(s => s.id === body.id ? { ...s, enabled: !!body.enabled } : s);
        } else return json({ error: "bad_action" }, 400);
        await env.NEWS_KV.put("sources_v2", JSON.stringify(next));
        return json({ sources: next });
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: "server_error", message: String(e && e.message || e).slice(0, 200) }, 500);
    }
  },
};

/* ---------- voice ---------- */
async function audio(request, env, ctx, url) {
  if (!env.AI) return json({ error: "no_ai_binding" }, 503);
  const id = url.searchParams.get("id") || "";
  const mode = ["brief", "detail", "title"].includes(url.searchParams.get("mode")) ? url.searchParams.get("mode") : "brief";
  const lead = url.searchParams.get("lead") === "1";
  const intro = Math.max(0, Math.min(999, parseInt(url.searchParams.get("intro") || "0", 10) || 0));
  if (!/^[\w.-]{1,120}$/.test(id)) return json({ error: "bad_id" }, 400);

  const key = `a:${AUDIO_VERSION}:${id}:${mode}:${lead ? 1 : 0}:${intro}`;
  const cached = await env.NEWS_KV.get(key, "arrayBuffer");
  if (cached) return mp3(cached);

  const news = await ghJSON("data/news.json", []);
  const n = news.find(x => x.id === id);
  if (!n) return json({ error: "not_found" }, 404);

  const text = speechText(n, mode, lead, intro);
  const pieces = splitForTTS(text, 220);
  const parts = [];
  for (const piece of pieces) parts.push(await tts(env, piece));
  const total = parts.reduce((s, b) => s + b.byteLength, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const b of parts) { out.set(new Uint8Array(b), o); o += b.byteLength; }
  ctx.waitUntil(env.NEWS_KV.put(key, out.buffer, { expirationTtl: 3 * 86400 }));
  return mp3(out.buffer);
}

function speechText(n, mode, lead, intro) {
  const clean = s => String(s || "")
    .replace(/[（(][^）)]{0,30}[）)]/g, "")
    .replace(/[“”"「」『』【】《》]/g, "")
    .replace(/^[•·\-*]\s*/gm, "")
    .replace(/\s*[\/｜|]\s*/g, "，")
    .replace(/\n+/g, "。")
    .replace(/。+/g, "。")
    .replace(/\s+/g, " ").trim();
  const body = mode === "title" ? "" : mode === "detail" ? (n.detail || n.summary || "") : (n.summary || "");
  let t = "";
  if (intro) t += `为你播报${intro}条新闻。`;
  else if (lead) t += "下一条。";
  t += clean(n.title).replace(/[。！？]$/, "") + "。";
  if (body) t += clean(body);
  return t;
}
function splitForTTS(text, max) {
  const sentences = text.split(/(?<=[。！？；!?;])/).filter(s => s.trim());
  const out = []; let buf = "";
  for (const s of sentences) {
    if ((buf + s).length > max && buf) { out.push(buf); buf = s; } else buf += s;
  }
  if (buf.trim()) out.push(buf);
  return out;
}
async function tts(env, prompt) {
  const r = await env.AI.run("@cf/myshell-ai/melotts", { prompt, lang: "zh" });
  if (r instanceof ArrayBuffer) return r;
  if (r instanceof Uint8Array) return r.buffer;
  if (r && typeof r.getReader === "function") return await new Response(r).arrayBuffer();
  const b64 = r && (r.audio || (r.result && r.result.audio));
  if (!b64) throw new Error("tts_empty");
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function mp3(buf) {
  return new Response(buf, { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400", "accept-ranges": "none" } });
}

/* ---------- helpers ---------- */
function gh(path, ttl) {
  return fetch(RAW + path, { cf: { cacheTtl: ttl, cacheEverything: true } });
}
async function ghJSON(path, fallback) {
  try { const r = await gh(path, 60); return r.ok ? await r.json() : fallback; } catch { return fallback; }
}
async function loadSources(env) {
  const kv = env.NEWS_KV ? await env.NEWS_KV.get("sources_v2", "json") : null;
  if (Array.isArray(kv)) return kv;
  return ghJSON("data/sources.json", []);
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function authorized(request, env) {
  const want = env.ADMIN_TOKEN || "";
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!want || got.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

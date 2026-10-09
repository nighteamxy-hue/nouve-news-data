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
const AUDIO_VERSION = "v2";

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
  if (cached) return wav(cached, request);

  const news = await ghJSON("data/news.json", []);
  const n = news.find(x => x.id === id);
  if (!n) return json({ error: "not_found" }, 404);

  // Speak the opener, the title and the body as separate clips, then join them
  // with real silence so each sentence has room to land.
  const segs = speechSegments(n, mode, lead, intro);
  const pcm = await mapLimit(segs, 4, s => tts(env, s.text).then(decodeWav));
  const rate = pcm.find(Boolean)?.rate || 22050;
  const chunks = [];
  segs.forEach((s, i) => { if (pcm[i]) { chunks.push(pcm[i].samples); chunks.push(silence(rate, s.gap)); } });
  const out = encodeWav(chunks, rate);
  ctx.waitUntil(env.NEWS_KV.put(key, out, { expirationTtl: 3 * 86400 }));
  return wav(out, request);
}

/* Opener / title / body pieces, each with the pause (ms) that follows it. */
function speechSegments(n, mode, lead, intro) {
  const segs = [];
  if (intro) segs.push({ text: `为你播报${intro}条新闻。`, gap: 600 });
  else if (lead) segs.push({ text: "下一条。", gap: 500 });
  const t = speechText(n, "title", false, 0);
  segs.push({ text: t, gap: mode === "title" ? 1200 : 800 });
  if (mode !== "title") {
    const body = speechText(n, mode, false, 0).slice(t.length);
    for (const piece of splitForTTS(body, 90)) segs.push({ text: piece, gap: 450 });
    segs[segs.length - 1].gap = 1200;
  }
  return segs;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  async function worker() { while (next < items.length) { const i = next++; try { out[i] = await fn(items[i]); } catch { out[i] = null; } } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (!out.some(Boolean)) throw new Error("tts_failed");
  return out;
}
/* Parse a 16-bit PCM WAV; halve 44.1/48 kHz audio to keep files small. */
function decodeWav(buf) {
  const v = new DataView(buf);
  if (v.getUint32(0, false) !== 0x52494646) throw new Error("not_wav");
  let o = 12, rate = 44100, ch = 1, bits = 16, data = null;
  while (o + 8 <= buf.byteLength) {
    const id = v.getUint32(o, false), size = v.getUint32(o + 4, true);
    if (id === 0x666d7420) { ch = v.getUint16(o + 10, true); rate = v.getUint32(o + 12, true); bits = v.getUint16(o + 22, true); }
    else if (id === 0x64617461) { data = new Int16Array(buf.slice(o + 8, o + 8 + Math.min(size, buf.byteLength - o - 8) & ~1)); break; }
    o += 8 + size + (size & 1);
  }
  if (!data || bits !== 16) throw new Error("bad_wav");
  if (ch > 1) { const m = new Int16Array(Math.floor(data.length / ch)); for (let i = 0; i < m.length; i++) m[i] = data[i * ch]; data = m; }
  if (rate >= 44100) {
    const h = new Int16Array(Math.floor(data.length / 2));
    for (let i = 0; i < h.length; i++) h[i] = (data[2 * i] + data[2 * i + 1]) >> 1;
    data = h; rate = Math.round(rate / 2);
  }
  return { rate, samples: data };
}
function silence(rate, ms) { return new Int16Array(Math.round(rate * ms / 1000)); }
function encodeWav(chunks, rate) {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  const pcm = new Int16Array(buf, 44); let o = 0;
  for (const c of chunks) { pcm.set(c, o); o += c.length; }
  return buf;
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
  const sentences = text.split(/(?<=[。！？；!?;])/).filter(s => s.trim())
    .flatMap(s => s.length <= max ? [s] : s.split(/(?<=[，,、：:])/))
    .flatMap(s => s.length <= max ? [s] : s.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")));
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
function wav(buf, request) {
  // iPhone Safari fetches audio in byte ranges; answer them so playback starts.
  const size = buf.byteLength;
  const h = { "content-type": "audio/wav", "cache-control": "public, max-age=86400", "accept-ranges": "bytes" };
  const m = /^bytes=(\d*)-(\d*)$/.exec((request && request.headers.get("range")) || "");
  if (m && (m[1] || m[2])) {
    let start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
    let end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...h, "content-range": `bytes */${size}` } });
    return new Response(buf.slice(start, end + 1), { status: 206, headers: { ...h, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(buf, { headers: { ...h, "content-length": String(size) } });
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

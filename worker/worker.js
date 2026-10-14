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
const CATS = ["ai", "econ", "stock", "crypto", "tech", "robot", "travel", "general"];
// v3 = Cloudflare's free voice (MeloTTS). v4 = Microsoft Azure voice 晓晓, used once the
// AZURE_SPEECH_KEY / AZURE_SPEECH_REGION settings exist. Clips of the two never mix.
let AUDIO_VERSION = "v3";
const useAzure = env => !!(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION);
const AZ_VOICE = "zh-CN-XiaoxiaoNeural", AZ_RATE = 24000;

export default {
  // Cron trigger: turn new news into speech ahead of time, so play starts at once.
  async scheduled(event, env, ctx) { AUDIO_VERSION = useAzure(env) ? "v4" : "v3"; ctx.waitUntil(pregen(env, 36)); },
  async fetch(request, env, ctx) {
    AUDIO_VERSION = useAzure(env) ? "v4" : "v3";
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
        if (env.AI) ctx.waitUntil(pregen(env, 12).catch(() => {}));   // someone is listening: get the next clips ready
        const body = `{"news":${newsText},"sources":${JSON.stringify(sources)},"meta":${JSON.stringify({ ...meta, voice: !!env.AI })}}`;
        return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      }
      if (request.method === "GET" && p === "/api/audio") return audio(request, env, ctx, url);
      if (request.method === "GET" && p === "/api/stream") return stream(request, env, ctx, url);
      if (request.method === "GET" && p === "/api/sources") return json(await loadSources(env));
      if (request.method === "GET" && p === "/api/log") {
        // Run log for the 6-hourly update task: ?m=<message> appends, no m reads.
        const log = (await env.NEWS_KV.get("tasklog", "json")) || [];
        const m = (url.searchParams.get("m") || "").slice(0, 1500);
        if (!m) return json(log);
        log.unshift({ at: new Date().toISOString(), m });
        await env.NEWS_KV.put("tasklog", JSON.stringify(log.slice(0, 40)));
        return json({ ok: true });
      }
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

  // The news clip is made once (usually ahead of time by pregen) and reused;
  // the short opener ("下一条" / "为你播报N条新闻") is its own cached clip.
  const corePromise = (async () => {
    const hit = await env.NEWS_KV.get(coreKey(id, mode), "arrayBuffer");
    if (hit) return decodeWav(hit);
    const news = await ghJSON("data/news.json", []);
    const n = news.find(x => x.id === id);
    if (!n) return null;
    return makeClip(env, ctx, coreKey(id, mode), speechSegments(n, mode, env));
  })();
  const openText = intro ? `为你播报${intro}条新闻。` : lead ? "下一条。" : "";
  const openKey = intro ? `a:${AUDIO_VERSION}:_intro:${intro}` : `a:${AUDIO_VERSION}:_next`;
  const openPromise = openText ? cachedClip(env, ctx, openKey, [{ text: openText, gap: intro ? 600 : 500 }], 30 * 86400) : null;
  const [core, open] = await Promise.all([corePromise, openPromise]);
  if (!core) return json({ error: "not_found" }, 404);
  const parts = open && open.rate === core.rate ? [open.samples, core.samples] : [core.samples];
  return wav(encodeWav(parts, core.rate), request);
}
const coreKey = (id, mode) => `a:${AUDIO_VERSION}:${id}:${mode}`;
async function cachedClip(env, ctx, key, segs, ttl) {
  const hit = await env.NEWS_KV.get(key, "arrayBuffer");
  return hit ? decodeWav(hit) : makeClip(env, ctx, key, segs, ttl);
}
/* Speak each piece separately and join them with real silence, then cache the WAV. */
async function makeClip(env, ctx, key, segs, ttl = 2 * 86400) {
  const pcm = await mapLimit(segs, 4, s => tts(env, s).then(decodeWav).then(c => useAzure(env) ? resample(c, AZ_RATE) : c));
  const rate = pcm.find(Boolean).rate;
  const chunks = [];
  segs.forEach((s, i) => { if (pcm[i] && pcm[i].rate === rate) { chunks.push(pcm[i].samples); chunks.push(silence(rate, s.gap)); } });
  const buf = encodeWav(chunks, rate);
  const put = env.NEWS_KV.put(key, buf, { expirationTtl: ttl, metadata: { pcm: buf.byteLength - 44 } });
  if (ctx) ctx.waitUntil(put); else await put;
  return { rate, samples: concat(chunks) };
}
function concat(chunks) {
  const out = new Int16Array(chunks.reduce((s, c) => s + c.length, 0)); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/* Make speech for today's news ahead of time: short versions first, then detailed ones.
   `budget` caps the number of text-to-speech calls in one run. */
async function pregen(env, budget) {
  if (!env.AI || !env.NEWS_KV) return;
  const news = await ghJSON("data/news.json", []);
  const since = Date.now() - 48 * 3600e3;
  const fresh = news.filter(n => !(Date.parse(n.publishedAt) < since));
  const doneList = (await env.NEWS_KV.get(`pregen_${AUDIO_VERSION}`, "json")) || [];
  const done = new Set(doneList);
  let calls = 0, made = 0, changed = false;
  // Only the short version is made ahead of time: the detailed one is rarely played and
  // its long clips would eat the free KV limits (1,000 writes a day, 1 GB storage).
  outer: for (const mode of ["brief"]) {
    for (const n of fresh) {
      const k = `${n.id}:${mode}`;
      if (done.has(k)) continue;
      if (mode === "detail" && !n.detail) { done.add(k); changed = true; continue; }
      const segs = speechSegments(n, mode, env);
      if (calls + segs.length > budget) break outer;
      calls += segs.length;
      try {
        if (!(await env.NEWS_KV.get(coreKey(n.id, mode), "arrayBuffer"))) { await makeClip(env, null, coreKey(n.id, mode), segs); made++; }
        done.add(k); changed = true;
      } catch {}
    }
  }
  if (changed) {
    const live = new Set(fresh.map(n => n.id));
    await env.NEWS_KV.put(`pregen_${AUDIO_VERSION}`, JSON.stringify([...done].filter(k => live.has(k.slice(0, k.lastIndexOf(":"))))));
  }
  return { made, calls };
}

/* Title and body pieces, each with the pause (ms) that follows it.
   With Azure the whole news item is one piece: the voice then reads it as a whole,
   with natural pauses and tone, instead of sentence by sentence. */
function speechSegments(n, mode, env) {
  if (env && useAzure(env)) {
    const t = speechText(n, "title");
    return [{ text: t, body: mode === "title" ? "" : speechText(n, mode).slice(t.length), gap: 1100 }];
  }
  const segs = [];
  const t = speechText(n, "title");
  segs.push({ text: t, gap: mode === "title" ? 1200 : 800 });
  if (mode !== "title") {
    const body = speechText(n, mode).slice(t.length);
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
    else if (id === 0x64617461) { const avail = buf.byteLength - o - 8; data = new Int16Array(buf.slice(o + 8, o + 8 + ((size && size <= avail ? size : avail) & ~1))); break; }
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
function writeWavHeader(v, dataBytes, rate) {
  const w = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, dataBytes, true);
}
function encodeWav(chunks, rate) {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  writeWavHeader(v, n * 2, rate);
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
/* Speech for one piece: Azure 晓晓 when set up (falls back to the free voice if Azure fails). */
async function tts(env, seg) {
  if (typeof seg === "string") seg = { text: seg };
  if (useAzure(env)) { try { return await ttsAzure(env, seg); } catch (e) { /* e.g. monthly free quota used up */ } }
  const prompt = seg.body ? seg.text + seg.body : seg.text;
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
const xmlEsc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function ssmlFor(seg) {
  const withBreaks = t => xmlEsc(t).replace(/([。！？；])/g, '$1<break time="200ms"/>');
  let inner = withBreaks(seg.text);
  if (seg.body) inner += '<break time="600ms"/>' + withBreaks(seg.body);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN">` +
    `<voice name="${AZ_VOICE}"><mstts:express-as style="newscast">${inner}</mstts:express-as></voice></speak>`;
}
async function ttsAzure(env, seg) {
  const r = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY, "Content-Type": "application/ssml+xml",
               "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm", "User-Agent": "nouve-news" },
    body: ssmlFor(seg),
  });
  if (!r.ok) throw new Error("azure_" + r.status);
  return r.arrayBuffer();
}
/* Simple linear resampling, so free-voice fallback clips still match Azure clips. */
function resample(c, to) {
  if (c.rate === to) return c;
  const n = Math.round(c.samples.length * to / c.rate), out = new Int16Array(n), k = c.rate / to;
  for (let i = 0; i < n; i++) { const x = i * k, j = Math.floor(x), f = x - j; const a = c.samples[j] || 0, b = c.samples[j + 1] ?? a; out[i] = Math.round(a + (b - a) * f); }
  return { rate: to, samples: out };
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

/* ---------- continuous stream ----------
   One long WAV for a whole list of news, sent piece by piece as the phone asks for it.
   The phone then plays a single file from start to end, so it never has to start a new
   file while the app is in the background (iPhone stops web audio at that point). */
const LAYOUT_VERSION = "l1";
async function sha1hex(text) {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
/* Byte length of every cached clip, from the metadata saved with it (one list call). */
async function clipLengths(env) {
  const out = new Map(); let cursor;
  do {
    const r = await env.NEWS_KV.list({ prefix: `a:${AUDIO_VERSION}:`, cursor });
    for (const k of r.keys) if (k.metadata && k.metadata.pcm) out.set(k.name, k.metadata.pcm);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}
/* Where each clip sits inside the long stream. Worked out once per list, then cached. */
async function streamLayout(env, ctx, mode, intro, ids) {
  const key = `pl:${LAYOUT_VERSION}:` + await sha1hex(`${AUDIO_VERSION}|${mode}|${intro}|${ids.join(",")}`);
  const hit = await env.NEWS_KV.get(key, "json");
  if (hit) return hit;
  const [news, lens] = await Promise.all([ghJSON("data/news.json", []), clipLengths(env)]);
  const byId = new Map(news.map(n => [n.id, n]));
  const list = ids.map(id => byId.get(id)).filter(Boolean);
  if (!list.length) return null;
  const nextKey = `a:${AUDIO_VERSION}:_next`, introKey = `a:${AUDIO_VERSION}:_intro:${intro}`;
  const [nextClip, introClip] = await Promise.all([
    cachedClip(env, ctx, nextKey, [{ text: "下一条。", gap: 500 }], 30 * 86400),
    intro ? cachedClip(env, ctx, introKey, [{ text: `为你播报${intro}条新闻。`, gap: 600 }], 30 * 86400) : null,
  ]);
  const rate = nextClip.rate;
  let budget = 28;   // text-to-speech calls allowed for clips that aren't ready yet
  const lengths = new Array(list.length).fill(null);
  await mapLimit(list.map((n, i) => ({ n, i })), 4, async ({ n, i }) => {
    const k = coreKey(n.id, mode);
    if (lens.has(k)) { lengths[i] = lens.get(k); return true; }
    const v = await env.NEWS_KV.get(k, "arrayBuffer");
    if (v) { lengths[i] = v.byteLength - 44; return true; }
    const segs = speechSegments(n, mode, env);
    if (budget < segs.length) return true;
    budget -= segs.length;
    const c = await makeClip(env, ctx, k, segs);
    if (c.rate === rate) lengths[i] = c.samples.length * 2;
    return true;
  });
  const parts = [], items = []; let pos = 0;
  list.forEach((n, i) => {
    if (lengths[i] == null) return;
    const start = pos;
    const pre = items.length === 0 ? (introClip ? [introKey, introClip.samples.length * 2] : null) : [nextKey, nextClip.samples.length * 2];
    if (pre) { parts.push(pre); pos += pre[1]; }
    parts.push([coreKey(n.id, mode), lengths[i]]); pos += lengths[i];
    items.push([n.id, start, pos]);
  });
  const layout = { rate, parts, items, total: pos };
  ctx.waitUntil(env.NEWS_KV.put(key, JSON.stringify(layout), { expirationTtl: 86400 }));
  return layout;
}
async function stream(request, env, ctx, url) {
  if (!env.AI) return json({ error: "no_ai_binding" }, 503);
  const mode = ["brief", "detail", "title"].includes(url.searchParams.get("m")) ? url.searchParams.get("m") : "brief";
  const intro = Math.max(0, Math.min(999, parseInt(url.searchParams.get("i") || "0", 10) || 0));
  const ids = (url.searchParams.get("ids") || "").split(",").filter(x => /^[\w.-]{1,120}$/.test(x)).slice(0, 400);
  if (!ids.length) return json({ error: "no_ids" }, 400);
  const L = await streamLayout(env, ctx, mode, intro, ids);
  if (!L || !L.items.length) return json({ error: "not_found" }, 404);
  if (url.searchParams.get("layout") === "1") {
    const sec = b => b / (2 * L.rate);
    return json({ items: L.items.map(([id, s, e]) => ({ id, s: sec(s), e: sec(e) })) });
  }
  const size = 44 + L.total;
  const h = { "content-type": "audio/wav", "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
  let start = 0, end = size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
  if (m && (m[1] || m[2])) {
    start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
    end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...h, "content-range": `bytes */${size}` } });
    status = 206; h["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  h["content-length"] = String(end - start + 1);
  const header = new Uint8Array(44); writeWavHeader(new DataView(header.buffer), L.total, L.rate);
  const starts = []; let acc = 44;
  for (const [, len] of L.parts) { starts.push(acc); acc += len; }
  let cur = start, k = 0;
  const body = new ReadableStream({
    async pull(ctrl) {
      if (cur > end) { ctrl.close(); return; }
      if (cur < 44) { const e2 = Math.min(44, end + 1); ctrl.enqueue(header.slice(cur, e2)); cur = e2; return; }
      while (k < L.parts.length && starts[k] + L.parts[k][1] <= cur) k++;
      if (k >= L.parts.length) { ctrl.close(); return; }
      const [pk, plen] = L.parts[k];
      const from = cur - starts[k], to = Math.min(plen, end + 1 - starts[k]);
      const out = new Uint8Array(to - from);   // stays silent if a clip went missing
      const v = await env.NEWS_KV.get(pk, { type: "arrayBuffer", cacheTtl: 3600 });
      if (v && v.byteLength > 44) { const pcm = new Uint8Array(v, 44); if (from < pcm.length) out.set(pcm.subarray(from, Math.min(to, pcm.length))); }
      ctrl.enqueue(out);
      cur = starts[k] + to;
    },
  });
  const { readable, writable } = new FixedLengthStream(end - start + 1);
  ctx.waitUntil(body.pipeTo(writable));
  return new Response(readable, { status, headers: h });
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

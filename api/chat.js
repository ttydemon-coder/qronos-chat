// Vercel serverless function — POST /api/chat
// Streams /v1/chat/completions (SSE) to the browser.
// Optional agentic web access: body.web_access=true gives the model
// web_search / web_fetch tools and runs a tool loop (max MAX_HOPS),
// streaming progress and the final answer as SSE events:
//   data: {"delta":"..."}    — answer text chunk
//   data: {"status":"..."}   — progress note (shown as a chip)
//   data: {"done":true}      — end of answer
//   data: {"error":"..."}    — failure
// Auth: env QRONOS_API_KEY, or fallback header x-qronos-key.
const BASE = process.env.QRONOS_BASE || "https://qronos.me";
const UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const MAX_HOPS = 3;
const MAX_RESULTS = 5;
const MAX_FETCH_CHARS = 4000;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for up-to-date or factual information. Returns ranked results with titles, snippets and URLs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch the readable text content of a web page URL, when search snippets are not enough.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) URL of the page" },
        },
        required: ["url"],
      },
    },
  },
];

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function sendEvent(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/* ---------------- web tools ---------------- */

async function webSearch(query) {
  let html;
  try {
    const r = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        Accept: "text/html",
      },
      body: new URLSearchParams({ q: String(query || "") }).toString(),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`search HTTP ${r.status}`);
    html = await r.text();
  } catch (e) {
    return { error: `Search failed: ${e.message}` };
  }

  const results = [];
  const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < MAX_RESULTS) {
    let target = m[1];
    if (target.includes("uddg=")) {
      try {
        const u = target.startsWith("//") ? "https:" + target : target;
        target = decodeURIComponent(new URL(u).searchParams.get("uddg"));
      } catch {}
    }
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    if (title && target) results.push({ title, url: target, snippet: "" });
  }

  const snre = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0, s;
  while ((s = snre.exec(html)) && i < results.length) {
    results[i].snippet = s[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
    i++;
  }

  return results.length ? results : { note: "No results found for this query." };
}

async function webFetch(url) {
  const u = url.startsWith("http") ? url : "https://" + url;
  try {
    const r = await fetch(`https://r.jina.ai/${u}`, {
      headers: { "User-Agent": UA, Accept: "text/plain" },
      signal: AbortSignal.timeout(25000),
    });
    if (r.ok) {
      const t = await r.text();
      return { url, content: t.slice(0, MAX_FETCH_CHARS) };
    }
    const r2 = await fetch(u, {
      headers: { "User-Agent": UA, Accept: "text/html,text/plain" },
      signal: AbortSignal.timeout(25000),
    });
    if (!r2.ok) return { url, error: `HTTP ${r2.status}` };
    const html = await r2.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { url, content: text.slice(0, MAX_FETCH_CHARS) };
  } catch (e) {
    return { url, error: String(e && e.message ? e.message : e) };
  }
}

/* ---------------- upstream call (SSE parse + optional passthrough) ---------------- */

async function callUpstream({ res, key, model, messages, web, pass, statusText }) {
  const upstream = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(web ? { tools: TOOLS } : {}),
    }),
  });

  if (upstream.status !== 200) {
    const detail = await upstream.text();
    let msg = detail;
    try { msg = JSON.parse(detail).error?.message || detail; } catch {}
    const err = new Error(msg || `Upstream error ${upstream.status}`);
    err.upstreamStatus = upstream.status;
    throw err;
  }

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", calls = [], forwarded = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    for (const line of parts) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
      if (d.tool_calls) {
        if (forwarded) forwarded = false;
        for (const tc of d.tool_calls) {
          const idx = tc.index ?? 0;
          if (!calls[idx]) calls[idx] = { name: "", args: "" };
          if (tc.function?.name) calls[idx].name = tc.function.name;
          if (tc.function?.arguments) calls[idx].args += tc.function.arguments;
        }
      }
      if (d.content) {
        if (!calls.length && pass) {
          sendEvent(res, { delta: d.content });
          forwarded = true;
        }
        content += d.content;
      }
    }
  }

  if (!calls.length && !forwarded && pass && content) {
    sendEvent(res, { delta: content });
  }
  // one-off status so the client can show the searching chip
  if (calls.length && pass && statusText) {
    sendEvent(res, { status: "…" });
  }

  let parsedCalls = null;
  if (calls.length) {
    parsedCalls = calls.map((c, i) => ({
      id: `call_${i}_${c.name}`,
      type: "function",
      function: { name: c.name, arguments: c.args || "{}" },
    }));
  }
  return { content, tool_calls: parsedCalls };
}

/* ---------------- main handler ---------------- */

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    json(res, 405, { error: { message: "Method not allowed" } });
    return;
  }

  const key = process.env.QRONOS_API_KEY || req.headers["x-qronos-key"] || "";
  if (!key) {
    json(res, 401, {
      error: {
        message:
          "No API key configured. Set QRONOS_API_KEY env var on Vercel, or paste a key in the app.",
      },
    });
    return;
  }

  let raw = req.body;
  if (raw === undefined) {
    raw = await new Promise((resolve) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => resolve(buf));
      req.on("error", () => resolve(""));
    });
  }
  let payload = raw;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  if (!payload || !payload.model || !Array.isArray(payload.messages)) {
    json(res, 400, {
      error: { message: "Body must be JSON with `model` and `messages`." },
    });
    return;
  }

  const web = payload.web_access === true;

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders && res.flushHeaders();

  try {
    const messages = [...payload.messages];

    let hop;
    for (hop = 0; hop <= (web ? MAX_HOPS : 0); hop++) {
      const { content, tool_calls } = await callUpstream({
        res,
        key,
        model: payload.model,
        messages,
        web,
        pass: true,
        statusText: "🔎 Searching the web…",
      });

      if (!tool_calls) {
        sendEvent(res, { done: true });
        res.end();
        return;
      }

      // assistant issued tool calls — run them, then loop
      messages.push({ role: "assistant", content: content || null, tool_calls });

      for (const tc of tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        let result;
        if (tc.function.name === "web_search") {
          sendEvent(res, { status: `🔎 Searching: “${String(args.query || "").slice(0, 60)}”` });
          result = await webSearch(String(args.query || ""));
        } else if (tc.function.name === "web_fetch") {
          sendEvent(res, { status: `📄 Reading page…` });
          result = await webFetch(String(args.url || ""));
        } else {
          result = { error: `Unknown tool ${tc.function.name}` };
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result).slice(0, 8000),
        });
      }
    }

    // hop budget exhausted — force a final answer
    sendEvent(res, { status: "⏳ Composing answer from findings…" });
    messages.push({
      role: "user",
      content: "Stop searching now. Give your final answer using only what you already found.",
    });
    await callUpstream({ res, key, model: payload.model, messages, web: false, pass: true });
    sendEvent(res, { done: true });
    res.end();
  } catch (e) {
    sendEvent(res, { error: String(e && e.message ? e.message : e) });
    res.end();
  }
};

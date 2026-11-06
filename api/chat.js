// Vercel serverless function — POST /api/chat
// Streams /v1/chat/completions (SSE) straight through to the browser.
// Auth: env QRONOS_API_KEY, or fallback header x-qronos-key from the client.
const BASE = process.env.QRONOS_BASE || "https://qronos.me";

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

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

  // Vercel parses JSON bodies already; raw Node just gives us the stream.
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

  const out = {
    model: payload.model,
    messages: payload.messages,
    stream: payload.stream !== false,
  };
  if (Number.isFinite(payload.temperature)) out.temperature = payload.temperature;
  if (Number.isFinite(payload.max_tokens)) out.max_tokens = payload.max_tokens;

  let upstream;
  try {
    upstream = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: out.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(out),
    });
  } catch (e) {
    json(res, 502, { error: { message: "Upstream request failed", detail: String(e) } });
    return;
  }

  if (!(upstream.status === 200 && out.stream && upstream.body)) {
    const body = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering (nginx etc.)
  res.flushHeaders && res.flushHeaders();

  try {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // client aborted or upstream broke mid-stream — end quietly
  }
  res.end();
};

// Vercel serverless function — GET /api/usage
// Proxies Qronos /v1/usage (today's quota + per-model request/token counts).
// Auth: env QRONOS_API_KEY, or fallback header x-qronos-key from the client.
const BASE = process.env.QRONOS_BASE || "https://qronos.me";

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
    return;
  }

  const key = process.env.QRONOS_API_KEY || req.headers["x-qronos-key"] || "";
  if (!key) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: "No API key configured" } }));
    return;
  }

  try {
    const upstream = await fetch(`${BASE}/v1/usage`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    const body = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: "Usage request failed", detail: String(e) } }));
  }
};

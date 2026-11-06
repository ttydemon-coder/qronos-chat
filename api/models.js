// Vercel serverless function — GET /api/models
// Proxies the Qronos model list. Auth: env QRONOS_API_KEY, or fallback
// header x-qronos-key from the client.
const BASE = process.env.QRONOS_BASE || "https://qronos.me";

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    json(res, 405, { error: { message: "Method not allowed" } });
    return;
  }

  const key = process.env.QRONOS_API_KEY || req.headers["x-qronos-key"] || "";
  const headers = { Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;

  try {
    const upstream = await fetch(`${BASE}/v1/models`, { headers });
    const body = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.setHeader("Cache-Control", "max-age=300"); // models rarely change
    res.end(body);
  } catch (e) {
    json(res, 502, { error: { message: "Upstream request failed", detail: String(e) } });
  }
};

# Qronos Chat

A fast, mobile-first chat site for your **Qronos AI** gateway (https://qronos.me).
No build step, no framework — plain HTML/JS plus two tiny Vercel serverless
functions, so it loads almost instantly on phones.

**Live:** https://qronos-umber.vercel.app

## Features

- All 16 gateway models in a searchable picker, grouped free → ultra, with
  tier badges, context window and pricing per model
- Live streaming responses with a stop button
- Chat history saved locally on the device (last 60 messages)
- Free-tier models surfaced as quick-start buttons on the home screen
- Your API key never ships to the browser when using the env var

## Deploy to Vercel (2 steps)

1. Push this folder to GitHub and import it on Vercel (framework:
   **Other** — it's auto-detected as static + `api/` functions).
2. In the Vercel project → *Settings → Environment Variables*, add:

   | Name | Value |
   |---|---|
   | `QRONOS_API_KEY` | your Qronos key (`sk-…`) |

   Redeploy once after adding the variable.

Done — the site uses your key server-side; visitors can't see it.

## Using it without the env var (optional)

If `QRONOS_API_KEY` isn't set, users can paste their own key in the app
(padlock / key prompt appears on first 401). It's stored only in that
browser's localStorage and sent as `x-qronos-key` to your proxy.

## Local test

```bash
python3 -m http.server 8000 &        # serve static files
node -e "…"                          # or use `vercel dev` for the functions
```

The easiest local check is `npx vercel dev` (Node 18+), which serves both
the static site and the `/api/*` functions, then open
http://127.0.0.1:3000.

## Files

- `index.html`, `style.css`, `app.js` — the entire frontend
- `api/models.js` — proxies `GET /v1/models`
- `api/chat.js` — streams `POST /v1/chat/completions`

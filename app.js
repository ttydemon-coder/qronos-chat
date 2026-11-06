/* Qronos Chat — frontend logic */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const chatEl = $("chat");
  const inputEl = $("input");
  const sendBtn = $("sendBtn");
  const stopBtn = $("stopBtn");
  const errBanner = $("errBanner");

  let models = [];
  let currentModel = localStorage.getItem("qr:model") || "";
  let chat = load();
  let controller = null; // AbortController for in-flight stream

  function load() {
    try { return JSON.parse(localStorage.getItem("qr:chat") || "[]"); }
    catch { return []; }
  }
  const save = () => {
    localStorage.setItem("qr:chat", JSON.stringify(chat.slice(-60)));
    localStorage.setItem("qr:model", currentModel);
  };

  function modelById(id) { return models.find((m) => m.id === id); }

  function tierBadge(m, off) {
    const badge = m.min_tier === "free" ? "free" : m.min_tier;
    const extra = off ? ' <span class="badge off">region</span>' : "";
    return `<span class="badge ${badge}">${badge}${extra}</span>`;
  }

  /* ---------- error banner ---------- */
  let errTimer;
  function showError(msg, detail) {
    errBanner.innerHTML =
      `<strong>${msg}</strong>` + (detail ? `<br><code>${escapeHtml(detail)}</code>` : "");
    errBanner.classList.remove("hidden");
    clearTimeout(errTimer);
    errTimer = setTimeout(() => errBanner.classList.add("hidden"), 12000);
  }

  /* ---------- rendering ---------- */
  function welcome() {
    $("welcome").style.display = chat.length ? "none" : "";
    const zone = $("freeModels");
    zone.innerHTML = "";
    models.filter((m) => m.available && m.min_tier === "free").forEach((m) => {
      const b = document.createElement("button");
      b.textContent = m.display_name || m.id;
      b.onclick = () => { pick(m.id, false); inputEl.focus(); };
      zone.appendChild(b);
    });
  }

  function render() {
    messagesEl.className = "messages";
    messagesEl.innerHTML = "";
    chat.forEach((m) => {
      if (m.role === "assistant") addAssistant(m.content, false, m.meta);
      else addUserBubble(m.content);
    });
    welcome();
  }

  function addUserBubble(text) {
    const d = document.createElement("div");
    d.className = "msg user";
    d.innerHTML = `<div class="bubble"></div>`;
    d.firstElementChild.innerHTML = mdLite(text);
    messagesEl.appendChild(d);
    return d;
  }

  function addAssistant(md, streaming, meta) {
    const d = document.createElement("div");
    d.className = "msg assistant";
    const wrap = document.createElement("div");
    wrap.className = "bubble";
    wrap.innerHTML = streaming ? mdLite(md) + '<span class="cursor"></span>' : mdLite(md);
    d.appendChild(wrap);
    if (meta) {
      const m = document.createElement("div");
      m.className = "meta";
      m.textContent = meta;
      d.appendChild(m);
    }
    messagesEl.appendChild(d);
    if (streaming) wrap.dataset.raw = md;
    return wrap;
  }

  function metaLabel() {
    const m = modelById(currentModel);
    return m ? m.display_name || m.id : currentModel;
  }

  /* Tiny markdown: headings, bold, code fences, inline code, links, lists */
  function mdLite(src) {
    let out = escapeHtml(src);
    // fence code blocks
    out = out.replace(/```(\w*)([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code data-lang="${lang}">${code.replace(/\n$/, "")}</code></pre>`;
    });
    out = out
      .replace(/^### (.*)$/gm, "<h3>$1</h3>")
      .replace(/^## (.*)$/gm, "<h2>$1</h2>")
      .replace(/^# (.*)$/gm, "<h1>$1</h1>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\W)\*([^*\n]+)\*(?=$|\W)/g, "$1<em>$2</em>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/^\s*[-*] (.*)$/gm, (m, p1) => `<li>${p1}</li>`)
      .replace(/(<li>[^<]*<\/li>\n?)+/g, (m) => `<ul>${m.replace(/\n/g, "")}</ul>`)
      .replace(/(<h\d>.*?<\/h\d>)/g, "\n$1")
      .replace(/<\/pre>\n/g, "</pre>");
    // paragraphs (only outside the pre blocks we just made)
    return groupParagraphs(out);
  }

  function groupParagraphs(html) {
    const blocks = html.split(/\n{2,}/).map((b) =>
      /^\s*(<(?:pre|ul|ol|h[123]|li|blockquote|table|div))/i.test(b.trim())
        ? b.trim()
        : b.trim() ? `<p>${b.replace(/\n/g, "<br>")}</p>` : ""
    );
    return blocks.filter(Boolean).join("");
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function autoScroll(force) {
    const nearBottom =
      chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
    if (nearBottom || force) chatEl.scrollTop = chatEl.scrollHeight;
  }

  /* ---------- model picker ---------- */
  const sheet = $("modelSheet"), backdrop = $("sheetBackdrop");
  function openSheet(openEl) { backdrop.classList.remove("hidden"); openEl.classList.remove("hidden"); }
  function closeSheets() {
    backdrop.classList.add("hidden");
    sheet.classList.add("hidden");
    $("keySheet").classList.add("hidden");
  }
  backdrop.onclick = closeSheets;
  $("closeSheet").onclick = closeSheets;
  $("closeKey").onclick = closeSheets;

  $("modelBtn").onclick = () => {
    $("modelSearch").value = "";
    renderModels("");
    openSheet(sheet);
  };
  $("modelSearch").oninput = (e) => renderModels(e.target.value.toLowerCase());

  function renderModels(q) {
    const list = $("modelList");
    list.innerHTML = "";
    models
      .filter(
        (m) => !q ||
          m.id.toLowerCase().includes(q) ||
          (m.display_name || "").toLowerCase().includes(q)
      )
      .forEach((m) => {
        const off = !m.available;
        const btn = document.createElement("button");
        btn.className = "model-item" + (m.id === currentModel ? " active" : "");
        btn.innerHTML = `
          <span class="mid">${escapeHtml(m.display_name || m.id)} ${tierBadge(m, off)}</span>
          <span class="desc">${escapeHtml(m.description || "")}</span>
          <span class="desc">ctx ${(m.context_window || 0).toLocaleString()} · in $${m.pricing?.input_usd_per_million ?? "?"}/M · out $${m.pricing?.output_usd_per_million ?? "?"}/M</span>`;
        btn.onclick = () => {
          if (off) { showError("Model unavailable", `${m.id} is currently not available on the gateway.`); return; }
          pick(m.id);
        };
        list.appendChild(btn);
      });
  }

  function pick(id, close = true) {
    currentModel = id;
    $("modelName").textContent = (modelById(id)?.display_name || id);
    save();
    if (close) closeSheets();
  }

  /* Key sheet */
  $("keyForm").onsubmit = (e) => {
    e.preventDefault();
    const k = $("keyInput").value.trim();
    if (k) { localStorage.setItem("qr:key", k); closeSheets(); }
  };
  $("keySheet").onopen = () => openSheet($("keySheet"));

  function openKeySheet() {
    $("keyInput").value = localStorage.getItem("qr:key") || "";
    openSheet($("keySheet"));
  }

  /* ---------- chat flow ---------- */
  $("newChatBtn").onclick = () => {
    chat = [];
    save();
    render();
    inputEl.focus();
  };

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
    sendBtn.disabled = !(inputEl.value.trim() || chat.some((m) => m.role === "user"));
    sendBtn.parentElement.classList.toggle("has-text", !!inputEl.value.trim());
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && inputEl.value.trim()) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });

  $("stopBtn").onclick = () => controller && controller.abort();

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || controller) return;
    inputEl.value = "";
    inputEl.style.height = "auto";
    send(text);
  });

  async function send(text) {
    errBanner.classList.add("hidden");
    const key = localStorage.getItem("qr:key");
    if (text) chat.push({ role: "user", content: text });
    save();

    addUserBubble(text);
    autoScroll(true);

    const wrap = addAssistant("", true);
    autoScroll(true);

    sendBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    setBusy(true);

    let acc = "";
    controller = new AbortController();
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { "x-qronos-key": key } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: currentModel,
          messages: chat.filter((m) => m.role !== "assistant" || m.content).map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        let msg = body;
        try { msg = JSON.parse(body).error?.message || body; } catch {}
        handleApiError(res.status, msg);
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let usage = null;
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
          try {
            const j = JSON.parse(data);
            if (j.usage) usage = j.usage;
            const delta = j.choices?.[0]?.delta?.content || "";
            if (delta) acc += delta;
          } catch {}
        }
        wrap.innerHTML = mdLite(acc) + '<span class="cursor"></span>';
        autoScroll();
      }

      if (!acc) acc = "(empty response)";
      chat.push({ role: "assistant", content: acc, meta: metaLabel() });
      save();
      render();
    } catch (e) {
      if (e.name === "AbortError") {
        if (acc) { chat.push({ role: "assistant", content: acc, meta: metaLabel() }); save(); }
        render();
      } else if (acc) {
        chat.push({ role: "assistant", content: acc, meta: metaLabel() });
        save();
        render();
      } else {
        chat = chat.filter((m) => m.role !== "user" || m !== chat[chat.length - 1]);
        // remove trailing user msg only if assistant failed with no output
        render();
      }
    } finally {
      controller = null;
      stopBtn.classList.add("hidden");
      sendBtn.classList.remove("hidden");
      setBusy(false);
      welcome();
      autoScroll(true);
    }
  }

  function setBusy(b) {
    document.body.classList.toggle("busy", b);
    inputEl.disabled = b;
    if (!b) sendBtn.disabled = !inputEl.value.trim();
  }

  function handleApiError(status, msg) {
    if (status === 401) {
      showError("Missing or invalid API key", "Paste your Qronos key below.");
      openKeySheet();
    } else if (status === 403) {
      showError("Model not allowed on your plan", msg);
    } else if (status === 429) {
      showError("Rate limited", "Slow down or wait a moment, then try again.");
    } else if (status === 402) {
      showError("Out of credits", msg);
    } else {
      showError(`Error ${status || ""}`, msg);
    }
  }

  /* ---------- boot ---------- */
  async function initModels() {
    try {
      const key = localStorage.getItem("qr:key");
      const res = await fetch("/api/models", key ? { headers: { "x-qronos-key": key } } : {});
      const j = await res.json();
      models = (j.data || []).sort((a, b) => {
        const rank = { free: 0, starter: 1, plus: 2, pro: 3, ultra: 4 };
        return (rank[a.min_tier] ?? 9) - (rank[b.min_tier] ?? 9);
      });
      if (!currentModel || !modelById(currentModel)) {
        const firstFree = models.find((m) => m.available && m.min_tier === "free");
        currentModel = firstFree?.id || models[0]?.id || "";
      }
      $("modelName").textContent = modelById(currentModel)?.display_name || currentModel;
      welcome();
      renderModels("");
      document.body.dispatchEvent(new Event("models-ready"));
    } catch {
      $("modelName").textContent = "Error — tap to retry";
      showError("Could not load models", "Tap the model chip at top to retry.");
    }
  }

  render();
  initModels();
})();
/* AI Agent — frontend logic (no build step, vanilla JS).
 * BYOK keys live in localStorage only. Nothing is hardcoded or logged.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config / storage
  // ---------------------------------------------------------------------------

  const STORAGE_KEYS = {
    providers: 'aiAgent.providers',
    activeId: 'aiAgent.activeProviderId',
    messages: 'aiAgent.messages',
  };

  const USE_BACKEND = true;
  const BACKEND_BASE = 'https://ai-agent-backend.ai-agent-backend.workers.dev';
  const BACKEND_CHAT_URL = BACKEND_BASE + '/api/chat';
  const BACKEND_DEVICES_URL = BACKEND_BASE + '/api/devices';

  const LOCAL_PROVIDER = {
    id: 'local',
    name: 'Local (mock)',
    baseUrl: '',
    apiKey: '',
    model: 'mock',
    builtin: true,
  };

  // The phone-control MCP tools (shown for status; execution goes through the relay).
  const MCP_TOOLS = [
    { cat: '📷 Camera', tools: 'camera, photo, cam, screenshot, screen_touch, screen_record' },
    { cat: '💬 Messaging', tools: 'read_sms, send_sms, read_call_log, find_contact, dial_number' },
    { cat: '📱 Device', tools: 'battery, storage, network, phone_info, gps_on' },
    { cat: '📂 Files & Media', tools: 'file_get, file_put, record_audio, camera_link, screenshot_link' },
    { cat: '📜 Activity', tools: 'touch_feed, notifications, life_log_*' },
    { cat: '🖥️ Screen', tools: 'live_start, live_stop, tap_screen, phone_echo' },
  ];

  let providers = loadProviders();
  let activeId = localStorage.getItem(STORAGE_KEYS.activeId) || 'local';
  let editingId = null; // provider id being edited (null = adding new)

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  function loadProviders() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.providers);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length) return [LOCAL_PROVIDER, ...parsed.filter((p) => p && p.id !== 'local')];
    } catch (err) {
      console.warn('Could not read saved providers; resetting.');
    }
    return [LOCAL_PROVIDER];
  }

  function saveProviders() {
    const custom = providers.filter((p) => !p.builtin);
    localStorage.setItem(STORAGE_KEYS.providers, JSON.stringify(custom));
  }

  function loadMessages() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.messages)) || [];
    } catch {
      return [];
    }
  }

  function saveMessages(messages) {
    localStorage.setItem(STORAGE_KEYS.messages, JSON.stringify(messages));
  }

  function getActiveProvider() {
    return providers.find((p) => p.id === activeId) || LOCAL_PROVIDER;
  }

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);
  const providerSelect = $('#providerSelect');
  const providerForm = $('#providerForm');
  const providerFormWrap = $('#providerFormWrap');
  const providerFormTitle = $('#providerFormTitle');
  const removeProvider = $('#removeProvider');
  const providerList = $('#providerList');
  const activeModel = $('#activeModel');
  const chatStatus = $('#chatStatus');
  const messagesEl = $('#messages');
  const composer = $('#composer');
  const input = $('#input');
  const clearChat = $('#clearChat');
  const mcpStatusText = $('#mcpStatusText');
  const mcpDot = $('#mcpDot');
  const mcpToolsEl = $('#mcpTools');
  const themeToggle = $('#themeToggle');
  const micBtn = $('#micBtn');

  // ---------------------------------------------------------------------------
  // Provider selector + list (edit / delete)
  // ---------------------------------------------------------------------------

  function renderProviderSelect() {
    providerSelect.innerHTML = '';
    providers.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.builtin ? p.name : `${p.name} — ${p.model}`;
      providerSelect.appendChild(opt);
    });
    providerSelect.value = activeId;
    syncHeader();
    renderProviderList();
  }

  function renderProviderList() {
    providerList.innerHTML = '';
    const custom = providers.filter((p) => !p.builtin);
    if (!custom.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No custom providers yet — add one below.';
      providerList.appendChild(empty);
      return;
    }
    custom.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'prov-row';

      const info = document.createElement('div');
      info.className = 'prov-row__info';
      info.innerHTML =
        '<span class="prov-row__name"></span><span class="prov-row__model"></span>';
      info.querySelector('.prov-row__name').textContent = p.name;
      info.querySelector('.prov-row__model').textContent = p.model;

      const btnGroup = document.createElement('div');
      btnGroup.className = 'prov-row__btns';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'icon-btn';
      editBtn.title = 'Edit';
      editBtn.textContent = '✎';
      editBtn.addEventListener('click', () => startEditProvider(p.id));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-btn icon-btn--danger';
      delBtn.title = 'Delete';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => deleteProvider(p.id));

      btnGroup.appendChild(editBtn);
      btnGroup.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(btnGroup);
      providerList.appendChild(row);
    });
  }

  function syncHeader() {
    const p = getActiveProvider();
    activeModel.textContent = p.builtin ? p.name : `${p.name} · ${p.model}`;
    chatStatus.textContent = p.builtin
      ? 'offline · mock mode'
      : `${p.model} · BYOK ready`;
    removeProvider.hidden = !!p.builtin;
    updateComposerPlaceholder(p);
  }

  // Keep the active provider/model visible right where the user types.
  function updateComposerPlaceholder(p) {
    const label = p.builtin ? p.name : `${p.name} · ${p.model}`;
    input.placeholder = 'Message ' + label + '… (Enter to send, Shift+Enter for newline)';
  }

  function fillForm(p) {
    $('#provName').value = p ? p.name : '';
    $('#provBaseUrl').value = p ? p.baseUrl : '';
    $('#provApiKey').value = p ? p.apiKey : '';
    $('#provModel').value = p ? p.model : '';
  }

  function setFormMode(mode) {
    editingId = mode === 'edit' ? activeId : null;
    if (mode === 'edit') {
      const p = getActiveProvider();
      if (p && !p.builtin) {
        fillForm(p);
        providerFormTitle.textContent = '✎ Edit provider';
        providerFormWrap.open = true;
      }
    } else {
      editingId = null;
      fillForm(null);
      providerFormTitle.textContent = '＋ Add custom provider (BYOK)';
    }
  }

  function startEditProvider(id) {
    activeId = id;
    localStorage.setItem(STORAGE_KEYS.activeId, activeId);
    renderProviderSelect();
    setFormMode('edit');
  }

  function deleteProvider(id) {
    const p = providers.find((x) => x.id === id);
    if (!p || p.builtin) return;
    providers = providers.filter((x) => x.id !== id);
    if (activeId === id) activeId = 'local';
    localStorage.setItem(STORAGE_KEYS.activeId, activeId);
    if (editingId === id) setFormMode('add');
    saveProviders();
    renderProviderSelect();
  }

  providerSelect.addEventListener('change', () => {
    activeId = providerSelect.value;
    localStorage.setItem(STORAGE_KEYS.activeId, activeId);
    syncHeader();
  });

  providerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#provName').value.trim();
    const baseUrl = $('#provBaseUrl').value.trim();
    const apiKey = $('#provApiKey').value.trim();
    const model = $('#provModel').value.trim();
    if (!name || !baseUrl || !apiKey || !model) return;

    if (editingId) {
      const p = providers.find((x) => x.id === editingId);
      if (p) {
        p.name = name;
        p.baseUrl = baseUrl;
        p.apiKey = apiKey;
        p.model = model;
      }
    } else {
      const id = 'prov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      providers.push({ id, name, baseUrl, apiKey, model, builtin: false });
      activeId = id;
    }
    localStorage.setItem(STORAGE_KEYS.activeId, activeId);
    saveProviders();
    providerForm.reset();
    providerFormWrap.open = false;
    setFormMode('add');
    renderProviderSelect();
  });

  removeProvider.addEventListener('click', () => {
    deleteProvider(activeId);
  });

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

  let messages = loadMessages();

  function renderMessages() {
    messagesEl.innerHTML = '';
    messages.forEach((m) => messagesEl.appendChild(renderMessage(m)));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderMessage(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (m.role === 'user' ? 'msg--user' : 'msg--assistant');
    const bubble = document.createElement('div');
    bubble.className = 'msg__bubble';
    bubble.innerHTML = linkify(m.content);
    const meta = document.createElement('div');
    meta.className = 'msg__meta';
    const metaLabel = document.createElement('span');
    metaLabel.className = 'msg__meta-label';
    metaLabel.textContent = m.role === 'user' ? 'You' : 'AI Agent' + (m.model ? ' · ' + m.model : '');
    meta.appendChild(metaLabel);
    if (m.role === 'assistant') {
      meta.appendChild(createSpeakerButton(m));
    }
    wrap.appendChild(bubble);

    // Inline media (data.media or bare URLs found in the reply) — assistant only.
    if (m.role === 'assistant') {
      const mediaItems = buildMediaList(m);
      if (mediaItems.length) {
        const mediaWrap = document.createElement('div');
        mediaWrap.className = 'msg__media';
        mediaItems.forEach((item) => mediaWrap.appendChild(createMediaItem(item)));
        wrap.appendChild(mediaWrap);
      }
    }

    wrap.appendChild(meta);
    if (Array.isArray(m.tools) && m.tools.length) {
      wrap.appendChild(renderToolChips(m.tools));
    }
    return wrap;
  }

  // -------------------------------------------------------------------------
  // URL / media helpers
  // -------------------------------------------------------------------------

  const URL_SCAN_RE = /https?:\/\/[^\s"'<>]+/gi;
  const MEDIA_EXT_RE = /\.(?:jpe?g|png|gif|webp|mp4|mov|webm|m4v)(?:[?#]|$)/i;
  const TELEGRAM_FILE_RE = /telegram\.org\/file\/bot/i;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Make bare URLs in a message clickable while keeping the rest plain text.
  function linkify(text) {
    const str = String(text || '');
    const re = new RegExp(URL_SCAN_RE.source, 'gi');
    const out = [];
    let last = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) out.push(escapeHtml(str.slice(last, m.index)));
      const url = m[0];
      out.push(
        '<a class="msg__link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(url) + '</a>'
      );
      last = re.lastIndex;
    }
    out.push(escapeHtml(str.slice(last)));
    return out.join('');
  }

  function isMediaUrl(url) {
    return MEDIA_EXT_RE.test(url) || TELEGRAM_FILE_RE.test(url);
  }

  function mediaTypeFromUrl(url) {
    return /\.(?:mp4|mov|webm|m4v)(?:[?#]|$)/i.test(url) ? 'video' : 'image';
  }

  function cleanUrl(url) {
    return url.replace(/[.,;:!?'")\]}>]+$/, '');
  }

  // Combine explicit data.media + bare media URLs from the reply text (deduped),
  // so media renders even when the backend omits the `media` field.
  function buildMediaList(m) {
    const items = [];
    const seen = new Set();
    const push = (url, type) => {
      url = cleanUrl(String(url || '').trim());
      if (!url || seen.has(url)) return;
      seen.add(url);
      let kind = 'image';
      if (type === 'video' || type === 'image') kind = type;
      else kind = mediaTypeFromUrl(url);
      items.push({ url, type: kind });
    };

    if (Array.isArray(m.media)) {
      m.media.forEach((it) => {
        if (it && typeof it.url === 'string') push(it.url, it.type);
      });
    }

    if (typeof m.content === 'string') {
      const re = new RegExp(URL_SCAN_RE.source, 'gi');
      let mm;
      while ((mm = re.exec(m.content)) !== null) {
        const url = cleanUrl(mm[0]);
        if (isMediaUrl(url)) push(url, mediaTypeFromUrl(url));
      }
    }
    return items;
  }

  function createMediaItem(item) {
    const box = document.createElement('div');
    box.className = 'msg__media-item';

    let el;
    if (item.type === 'video') {
      el = document.createElement('video');
      el.controls = true;
      el.preload = 'metadata';
      el.playsInline = true;
      el.src = item.url;
    } else {
      el = document.createElement('img');
      el.loading = 'lazy';
      el.alt = 'Media';
      el.src = item.url;
      // Telegram serves files as application/octet-stream; re-fetch as a Blob
      // with a sniffed mime so the <img> renders inline instead of downloading.
      renderImageViaBlob(el, item.url);
    }
    el.className = 'msg__media-el';

    const dl = document.createElement('a');
    dl.className = 'msg__media-dl';
    dl.href = item.url;
    dl.target = '_blank';
    dl.rel = 'noopener noreferrer';
    dl.download = '';
    dl.textContent = '⬇ Download';

    box.appendChild(el);
    box.appendChild(dl);
    return box;
  }

  // Fetch an image URL, sniff its real mime from the bytes, and set the <img>
  // src to a Blob object URL so an octet-stream response still renders inline.
  function renderImageViaBlob(img, url) {
    fetch(url)
      .then((resp) => {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.arrayBuffer();
      })
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        let mime = 'image/jpeg';
        if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = 'image/jpeg';
        else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) mime = 'image/png';
        else if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) mime = 'image/gif';
        else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) mime = 'image/webp';
        const blob = new Blob([buf], { type: mime });
        img.src = URL.createObjectURL(blob);
      })
      .catch(() => {
        // Fall back to the direct URL (e.g. if the fetch is blocked).
        img.src = url;
      });
  }

  // Tool-chip row rendered under an assistant message when the backend reports
  // tools were invoked (data.tools_used). Chips stagger in via CSS animation.
  function renderToolChips(tools) {
    const row = document.createElement('div');
    row.className = 'msg__tools';

    const icon = document.createElement('span');
    icon.className = 'msg__tools-icon';
    icon.textContent = '🔧';
    icon.title = 'Tools used';
    row.appendChild(icon);

    tools.forEach((tool, i) => {
      const chip = document.createElement('span');
      chip.className = 'msg__tool';
      chip.textContent = tool;
      chip.style.animationDelay = i * 70 + 'ms';
      row.appendChild(chip);
    });

    return row;
  }

  function addMessage(role, content, model, tools, media, animate) {
    const msg = { role, content, model };
    if (Array.isArray(tools) && tools.length) msg.tools = tools;
    if (Array.isArray(media) && media.length) msg.media = media;
    messages.push(msg);
    const wrap = renderMessage(msg);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    saveMessages(messages);
    if (animate && role === 'assistant') {
      const bubble = wrap.querySelector('.msg__bubble');
      typeTextInto(bubble, content);
    }
  }

  // -------------------------------------------------------------------------
  // Typewriter ("streaming") effect — only NEW assistant replies animate.
  // Persisted messages render full via renderMessages(); this runs only when
  // addMessage() is called with animate=true (i.e. a live backend reply).
  // -------------------------------------------------------------------------
  const TYPEWRITER_TICK = 3;  // ms between reveals (~3ms/char)
  const TYPEWRITER_CHARS = 1; // characters revealed per tick
  const TYPING_CARET = '<span class="typing-caret" aria-hidden="true">▍</span>';

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function finishTyping(bubble) {
    const state = bubble && bubble._typing;
    if (!state || state.done) return;
    state.done = true;
    if (state.timer) clearInterval(state.timer);
    bubble.innerHTML = linkify(state.full);
    bubble.classList.remove('msg__bubble--typing');
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function typeTextInto(bubble, text) {
    const full = String(text || '');
    // Respect reduced-motion: reveal the whole term instantly, no loop.
    if (prefersReducedMotion()) {
      bubble.innerHTML = linkify(full);
      return;
    }
    const state = { full, done: false, timer: null };
    bubble._typing = state;
    bubble.classList.add('msg__bubble--typing');
    bubble.innerHTML = '';
    let i = 0;
    state.timer = setInterval(() => {
      i += TYPEWRITER_CHARS;
      if (i >= full.length) {
        finishTyping(bubble);
        return;
      }
      bubble.innerHTML = linkify(full.slice(0, i)) + TYPING_CARET;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, TYPEWRITER_TICK);
  }

  // Clicking a still-typing bubble reveals the full text immediately.
  messagesEl.addEventListener('click', (e) => {
    const bubble = e.target && e.target.closest ? e.target.closest('.msg__bubble') : null;
    if (bubble && bubble._typing && !bubble._typing.done) finishTyping(bubble);
  });

  // -------------------------------------------------------------------------
  // Text-to-speech (TTS, Tamil) — a speaker button per assistant message.
  // -------------------------------------------------------------------------
  let activeSpeaker = null;

  function createSpeakerButton(m) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg__speak';
    btn.textContent = '🔊';
    btn.title = 'Read aloud (Tamil)';
    btn.setAttribute('aria-label', 'Read aloud (Tamil)');
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => speakText(m.content, btn));
    return btn;
  }

  function updateSpeakerUI(btn, active) {
    btn.classList.toggle('msg__speak--active', active);
    btn.textContent = active ? '⏹' : '🔊';
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.setAttribute('aria-label', active ? 'Stop reading' : 'Read aloud (Tamil)');
    btn.title = active ? 'Stop reading' : 'Read aloud (Tamil)';
  }

  function speakText(text, btn) {
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      toast('🔇 Voice output is not supported in this browser');
      return;
    }
    // Clicking the currently-playing button → stop.
    if (activeSpeaker === btn) {
      speechSynthesis.cancel();
      return;
    }
    // Cancel any existing speech first, then speak fresh text.
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text || ''));
    u.lang = 'ta-IN';
    const voices = speechSynthesis.getVoices();
    const taVoice = voices.find((v) => /^ta\b/i.test(v.lang)) ||
      voices.find((v) => /tamil/i.test(v.lang));
    if (taVoice) u.voice = taVoice;
    u.onstart = () => { activeSpeaker = btn; updateSpeakerUI(btn, true); };
    u.onend = () => { if (activeSpeaker === btn) activeSpeaker = null; updateSpeakerUI(btn, false); };
    u.onerror = () => { if (activeSpeaker === btn) activeSpeaker = null; updateSpeakerUI(btn, false); };
    speechSynthesis.speak(u);
  }

  function showThinking() {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg--assistant msg--thinking';
    const bubble = document.createElement('div');
    bubble.className = 'msg__bubble';
    bubble.innerHTML =
      '<span class="thinking-dots"><i></i><i></i><i></i></span>' +
      '<span class="thinking-tools">' +
        '<span class="thinking-tools__label">AI working</span>' +
        '<span class="thinking-tools__chip">🔧</span>' +
        '<span class="thinking-tools__chip">📷</span>' +
        '<span class="thinking-tools__chip">💬</span>' +
        '<span class="thinking-tools__chip">📱</span>' +
      '</span>';
    const meta = document.createElement('div');
    meta.className = 'msg__meta';
    meta.textContent = 'AI Agent · thinking…';
    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  function errWithKind(kind, message) {
    const e = new Error(typeof message === 'string' ? message : 'Unknown error');
    e.kind = kind;
    return e;
  }

  // Map an HTTP status + backend error text to a friendly error "kind".
  function classifyError(status, detail) {
    const d = String(detail || '').toLowerCase();
    if (status === 401 || status === 403) return 'auth';
    if (/api\s?key|credential|unauthor|authentication|\bauth\b/.test(d)) return 'auth';
    if (/\bmodel\b/.test(d)) return 'model';
    if (status >= 500) return 'backend';
    if (status >= 400) return 'provider';
    return 'unknown';
  }

  // Turn a thrown error into a short, friendly prefixed message + raw detail line.
  function formatError(err) {
    const prefixes = {
      network: '🔌 Backend unreachable',
      auth: '🔑 Invalid API key',
      model: '🤖 Invalid model',
      provider: '🤖 Provider error',
      backend: '🔌 Backend error',
      unknown: '⚠️ Error',
    };
    const kind = (err && err.kind) || 'unknown';
    const detail = (err && err.message) ? err.message : String(err);
    const prefix = prefixes[kind] || prefixes.unknown;
    return detail ? prefix + '\n' + detail : prefix;
  }

  async function callBackend(provider, msgs) {
    let res;
    try {
      res = await fetch(BACKEND_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: {
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: provider.model,
          },
          messages: msgs.map(({ role, content }) => ({ role, content })),
          ...(selectedDeviceId ? { device_id: selectedDeviceId } : {}),
        }),
      });
    } catch (err) {
      // Fetch threw (DNS / connection refused / blocked) → backend unreachable.
      throw errWithKind('network', (err && err.message) ? err.message : 'Failed to fetch');
    }

    let data = null;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      if (data && data.rate_limited) {
        // Backend signalled a provider rate limit — carry the retry info up so
        // handleSend can auto-retry after the cooldown.
        return { rateLimited: true, retryAfter: data.retry_after || 60, error: data.error };
      }
      const detail = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      throw errWithKind(classifyError(res.status, detail), String(detail));
    }

    const reply = (data && data.reply && data.reply.content) || '(no content)';
    const tools = data && Array.isArray(data.tools_used) ? data.tools_used : [];
    const media = data && Array.isArray(data.media) ? data.media : [];
    return { content: reply, tools, media, rateLimited: false };
  }

  let isBusy = false;

  // Show a live countdown in the thinking bubble and resolve after `seconds`.
  function countdownForRetry(seconds, thinkingEl) {
    let remaining = seconds;
    const bubble = thinkingEl && thinkingEl.querySelector('.msg__bubble');
    const meta = thinkingEl && thinkingEl.querySelector('.msg__meta');
    return new Promise((resolve) => {
      const tick = () => {
        if (bubble) {
          bubble.innerHTML = '<span class="counting-label">⏳ Rate limit — ' + remaining + 's la auto-retry…</span>';
        }
        if (meta) meta.textContent = 'AI Agent · retrying…';
        if (remaining <= 0) { resolve(); return; }
        remaining--;
        setTimeout(tick, 1000);
      };
      tick();
    });
  }

  async function handleSend() {
    if (isBusy) return; // ignore rapid/duplicate sends while a request is in flight

    const text = input.value.trim();
    if (!text) return;

    const provider = getActiveProvider();

    // Backend mode + "Local (mock)" selected → ask for a provider instead of
    // surfacing a confusing upstream error.
    if (USE_BACKEND && provider.builtin) {
      addMessage(
        'assistant',
        '🔑 Add a provider first — open Settings and add a BYOK provider to chat with a real model.',
        provider.model
      );
      input.focus();
      return;
    }

    addMessage('user', text, provider.model);
    input.value = '';
    input.style.height = 'auto';

    // Build the outgoing history, dropping any empty/blank messages so the
    // backend never receives an empty (or only-whitespace) messages array.
    const history = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.trim())
      .map(({ role, content }) => ({ role, content }));

    if (!history.length) {
      // Defensive: nothing meaningful to send — restore the draft and bail.
      input.value = text;
      input.focus();
      return;
    }

    setComposerBusy(true);

    let reply;
    let toolsUsed = [];
    let mediaUsed = [];
    let ok = false;
    const thinkingEl = showThinking();
    try {
      if (USE_BACKEND) {
        // Auto-retry loop: on a provider rate limit, wait the cooldown and
        // re-send automatically (up to 3 attempts).
        for (let attempt = 1; attempt <= 3; attempt++) {
          const result = await callBackend(provider, history);
          if (!result.rateLimited) {
            reply = result.content;
            toolsUsed = Array.isArray(result.tools) ? result.tools : [];
            mediaUsed = Array.isArray(result.media) ? result.media : [];
            ok = true;
            break;
          }
          if (attempt === 3) {
            reply = '⏳ Rate limit innum irukku — konjam neram wait pannu, appuram try pannu.';
            break;
          }
          await countdownForRetry(Math.min(result.retryAfter || 60, 120), thinkingEl);
        }
      } else {
        await new Promise((r) => setTimeout(r, 350));
        reply = '[mock] ' + text;
        ok = true;
      }
    } catch (err) {
      reply = formatError(err);
    } finally {
      setComposerBusy(false);
    }

    thinkingEl.remove();
    addMessage('assistant', reply, provider.model, toolsUsed, mediaUsed, true);

    if (!ok) {
      // Re-insert the draft on error so the user's message is never lost.
      input.value = text;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    }
    input.focus();
  }

  function setComposerBusy(busy) {
    isBusy = busy;
    const btn = composer.querySelector('button[type=submit]');
    btn.disabled = busy;
    btn.textContent = busy ? '…' : 'Send';
  }

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSend();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  // -------------------------------------------------------------------------
  // Voice input (STT, Tamil) — microphone button in the composer.
  // -------------------------------------------------------------------------
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let isListening = false;

  function setListening(on) {
    isListening = on;
    if (!micBtn) return;
    micBtn.classList.toggle('composer__mic--active', on);
    micBtn.classList.toggle('is-listening', on);
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    micBtn.setAttribute('aria-label', on ? 'Stop voice input' : 'Voice input (Tamil)');
    micBtn.title = on ? 'Stop voice input' : 'Voice input (Tamil)';
    micBtn.textContent = on ? '🔴' : '🎤';
  }

  function toggleMic() {
    if (!recognition) {
      toast('🎤 Voice input not supported in this browser');
      return;
    }
    if (isListening) {
      try { recognition.stop(); } catch (err) { /* ignore */ }
      return;
    }
    try {
      recognition.start();
      setListening(true);
    } catch (err) {
      // start() throws if a session is already active; fall back to idle state.
      setListening(false);
    }
  }

  function initVoiceInput() {
    if (!micBtn) return;
    if (!SpeechRecognitionImpl) {
      micBtn.disabled = true;
      micBtn.classList.add('composer__mic--unsupported');
      micBtn.title = 'Voice input not supported in this browser';
      micBtn.setAttribute('aria-label', micBtn.title);
      toast('🎤 Voice input not supported in this browser');
      return;
    }

    recognition = new SpeechRecognitionImpl();
    recognition.lang = 'ta-IN';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (final) {
        input.value = final;
        input.dispatchEvent(new Event('input'));
        input.focus(); // focus but never auto-send
      } else if (interim) {
        input.value = interim;
        input.dispatchEvent(new Event('input'));
      }
    };

    recognition.onend = () => setListening(false);
    recognition.onerror = (event) => {
      setListening(false);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        toast('🎤 Microphone access denied');
      } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
        toast('🎤 Voice input error');
      }
    };

    micBtn.addEventListener('click', toggleMic);
  }

  // Transient confirmation toast (inline styles only — no new CSS required).
  function toast(message) {
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText =
      'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);' +
      'background:rgba(31,58,95,0.95);color:#e6edf3;padding:8px 14px;' +
      'border-radius:8px;font-size:13px;z-index:1000;pointer-events:none;' +
      'box-shadow:0 8px 30px rgba(0,0,0,0.35);transition:opacity 0.3s ease;';
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 350);
    }, 1400);
  }

  clearChat.addEventListener('click', (e) => {
    e.preventDefault();
    messages = [];
    saveMessages(messages);
    renderMessages();
    toast('Chat cleared');
  });

  // ---------------------------------------------------------------------------
  // MCP / phone status (from the backend relay)
  // ---------------------------------------------------------------------------

  const deviceSelect = $('#deviceSelect');
  let selectedDeviceId = localStorage.getItem('aiAgent.deviceId') || '';

  function populateDeviceSelect(devices) {
    if (!deviceSelect) return;
    const prev = selectedDeviceId;
    deviceSelect.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '📱 Auto device';
    deviceSelect.appendChild(auto);
    devices.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.device_id || d.id || '';
      opt.textContent = (d.online ? '🟢 ' : '🔴 ') + (d.name || d.model || d.device_id || '?');
      deviceSelect.appendChild(opt);
    });
    deviceSelect.value = prev;
  }

  if (deviceSelect) {
    deviceSelect.addEventListener('change', () => {
      selectedDeviceId = deviceSelect.value;
      if (selectedDeviceId) localStorage.setItem('aiAgent.deviceId', selectedDeviceId);
      else localStorage.removeItem('aiAgent.deviceId');
    });
  }

  async function refreshMcpStatus() {
    try {
      const res = await fetch(BACKEND_DEVICES_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const devices = Array.isArray(data.devices) ? data.devices : [];
      populateDeviceSelect(devices);
      const online = devices.filter((d) => d.online);
      if (online.length) {
        const names = online.map((d) => d.name || d.model || d.device_id).join(', ');
        mcpStatusText.textContent = 'Connected — ' + names;
        mcpDot.className = 'dot dot--online';
      } else if (devices.length) {
        mcpStatusText.textContent = 'Phone offline (' + devices.length + ' registered)';
        mcpDot.className = 'dot dot--offline';
      } else {
        mcpStatusText.textContent = 'No phone registered yet';
        mcpDot.className = 'dot dot--offline';
      }
    } catch (err) {
      mcpStatusText.textContent = 'Backend unreachable';
      mcpDot.className = 'dot dot--offline';
    }
  }

  function renderMcpTools() {
    mcpToolsEl.innerHTML = '';
    MCP_TOOLS.forEach((group) => {
      const li = document.createElement('li');
      li.innerHTML =
        '<span class="mcp-tool__cat"></span><span class="mcp-tool__names"></span>';
      li.querySelector('.mcp-tool__cat').textContent = group.cat;
      li.querySelector('.mcp-tool__names').textContent = group.tools;
      mcpToolsEl.appendChild(li);
    });
  }

  refreshMcpStatus();
  renderMcpTools();
  // Poll device status every 15s so the dot stays fresh.
  setInterval(refreshMcpStatus, 15000);

  // ---------------------------------------------------------------------------
  // PWA install prompt
  // ---------------------------------------------------------------------------

  const installBtn = $('#installBtn');
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.hidden = true;
  });

  // ---------------------------------------------------------------------------
  // Service worker registration (PWA offline shell)
  // ---------------------------------------------------------------------------

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Theme toggle (dark / light, persisted in localStorage)
  // ---------------------------------------------------------------------------

  const THEME_KEY = 'aiAgent.theme';
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');

  function applyTheme(theme) {
    const isLight = theme === 'light';
    document.documentElement.toggleAttribute('data-theme', isLight);
    if (themeToggle) {
      themeToggle.textContent = isLight ? '☀️' : '🌙';
      themeToggle.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
      themeToggle.setAttribute('aria-label', themeToggle.title);
    }
    if (themeColorMeta) themeColorMeta.setAttribute('content', isLight ? '#f4f6fa' : '#0a0d12');
  }

  function initTheme() {
    let theme = 'dark';
    try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* ignore */ }
    applyTheme(theme);
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        const next = document.documentElement.hasAttribute('data-theme') ? 'dark' : 'light';
        try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
        applyTheme(next);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Password gate (client-side lock screen)
  // ---------------------------------------------------------------------------
  const GATE_KEY = 'aiAgent.unlocked';
  const GATE_PASSWORD = 'AI_AGENT';
  const passwordGate = document.getElementById('passwordGate');
  const gateForm = document.getElementById('gateForm');
  const gatePassword = document.getElementById('gatePassword');
  const gateError = document.getElementById('gateError');
  const gateCard = passwordGate ? passwordGate.querySelector('.gate__card') : null;

  function isUnlocked() {
    try { return sessionStorage.getItem(GATE_KEY) === '1'; } catch { return false; }
  }

  function showGate() {
    if (!passwordGate) return;
    passwordGate.style.display = 'flex';
    if (gatePassword) gatePassword.focus();
  }

  function hideGate() {
    if (!passwordGate) return;
    passwordGate.style.display = 'none';
  }

  function shakeGate() {
    if (!gateCard) return;
    gateCard.classList.remove('gate__card--shake');
    void gateCard.offsetWidth; // force reflow so the animation can restart
    gateCard.classList.add('gate__card--shake');
  }

  function failGate() {
    if (gateError) gateError.classList.add('is-visible');
    shakeGate();
    if (gatePassword) {
      gatePassword.value = '';
      gatePassword.focus();
    }
  }

  function initGate() {
    if (!passwordGate || !gateForm) return;
    if (isUnlocked()) hideGate();
    else showGate();

    gateForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (gatePassword && gatePassword.value === GATE_PASSWORD) {
        try { sessionStorage.setItem(GATE_KEY, '1'); } catch { /* ignore */ }
        if (gateError) gateError.classList.remove('is-visible');
        hideGate();
      } else {
        failGate();
      }
    });

    // Clear the error as soon as the user starts typing again.
    if (gatePassword) {
      gatePassword.addEventListener('input', () => {
        if (gateError) gateError.classList.remove('is-visible');
      });
    }
  }

  // Lock / Logout affordance in the sidebar footer.
  const lockApp = $('#lockApp');
  if (lockApp) {
    lockApp.addEventListener('click', () => {
      try { sessionStorage.removeItem(GATE_KEY); } catch { /* ignore */ }
      location.reload();
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  initGate();
  initTheme();
  renderProviderSelect();
  renderMessages();
  input.focus();
  initVoiceInput();

  const sidebar = $('#sidebar');
  $('#openSidebar').addEventListener('click', () => sidebar.classList.add('sidebar--open'));
  $('#closeSidebar').addEventListener('click', () => sidebar.classList.remove('sidebar--open'));
})();
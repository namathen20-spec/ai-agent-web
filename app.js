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
    bubble.textContent = m.content;
    const meta = document.createElement('div');
    meta.className = 'msg__meta';
    meta.textContent = m.role === 'user' ? 'You' : 'AI Agent' + (m.model ? ' · ' + m.model : '');
    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    if (Array.isArray(m.tools) && m.tools.length) {
      wrap.appendChild(renderToolChips(m.tools));
    }
    return wrap;
  }

  // Subtle tool-chip row rendered under an assistant message when the backend
  // reports tools were invoked (data.tools_used). Inline styles only so we don't
  // depend on new CSS in style.css.
  function renderToolChips(tools) {
    const row = document.createElement('div');
    row.className = 'msg__tools';
    row.style.cssText =
      'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center;';

    const icon = document.createElement('span');
    icon.textContent = '🔧';
    icon.title = 'Tools used';
    icon.style.cssText = 'font-size:12px;line-height:20px;color:#8b98a9;';
    row.appendChild(icon);

    tools.forEach((tool) => {
      const chip = document.createElement('span');
      chip.className = 'msg__tool';
      chip.textContent = tool;
      chip.style.cssText =
        'font-size:11px;line-height:20px;padding:0 8px;border-radius:999px;' +
        'background:#1f3a5f;color:#7aa5ff;border:1px solid #263140;';
      row.appendChild(chip);
    });

    return row;
  }

  function addMessage(role, content, model, tools) {
    const msg = { role, content, model };
    if (Array.isArray(tools) && tools.length) msg.tools = tools;
    messages.push(msg);
    messagesEl.appendChild(renderMessage(messages[messages.length - 1]));
    messagesEl.scrollTop = messagesEl.scrollHeight;
    saveMessages(messages);
  }

  function showThinking() {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg--assistant msg--thinking';
    const bubble = document.createElement('div');
    bubble.className = 'msg__bubble';
    bubble.innerHTML = '<span class="thinking-dots"><i></i><i></i><i></i></span>';
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
        }),
      });
    } catch (err) {
      // Fetch threw (DNS / connection refused / blocked) → backend unreachable.
      throw errWithKind('network', (err && err.message) ? err.message : 'Failed to fetch');
    }

    let data = null;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      const detail = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      throw errWithKind(classifyError(res.status, detail), String(detail));
    }

    const reply = (data && data.reply && data.reply.content) || '(no content)';
    const tools = data && Array.isArray(data.tools_used) ? data.tools_used : [];
    return { content: reply, tools };
  }

  let isBusy = false;

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
    let ok = false;
    const thinkingEl = showThinking();
    try {
      if (USE_BACKEND) {
        const result = await callBackend(provider, history);
        reply = result.content;
        toolsUsed = Array.isArray(result.tools) ? result.tools : [];
      } else {
        await new Promise((r) => setTimeout(r, 350));
        reply = '[mock] ' + text;
      }
      ok = true;
    } catch (err) {
      reply = formatError(err);
    } finally {
      setComposerBusy(false);
    }

    thinkingEl.remove();
    addMessage('assistant', reply, provider.model, toolsUsed);

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

  async function refreshMcpStatus() {
    try {
      const res = await fetch(BACKEND_DEVICES_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const devices = Array.isArray(data.devices) ? data.devices : [];
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
  // Boot
  // ---------------------------------------------------------------------------

  renderProviderSelect();
  renderMessages();
  input.focus();

  const sidebar = $('#sidebar');
  $('#openSidebar').addEventListener('click', () => sidebar.classList.add('sidebar--open'));
  $('#closeSidebar').addEventListener('click', () => sidebar.classList.remove('sidebar--open'));
})();
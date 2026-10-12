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
    return wrap;
  }

  function addMessage(role, content, model) {
    messages.push({ role, content, model });
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

  async function callBackend(provider, msgs) {
    const res = await fetch(BACKEND_CHAT_URL, {
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
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const data = await res.json();
    return data.reply?.content || '(no content)';
  }

  async function handleSend() {
    const text = input.value.trim();
    if (!text) return;

    const provider = getActiveProvider();
    addMessage('user', text, provider.model);
    input.value = '';
    input.style.height = 'auto';
    setComposerBusy(true);

    let reply;
    const thinkingEl = showThinking();
    try {
      if (USE_BACKEND) {
        reply = await callBackend(provider, messages.slice(0, -1));
      } else {
        await new Promise((r) => setTimeout(r, 350));
        reply = '[mock] ' + text;
      }
    } catch (err) {
      reply = '⚠️ Error: ' + (err && err.message ? err.message : err);
    } finally {
      setComposerBusy(false);
    }
    thinkingEl.remove();
    addMessage('assistant', reply, provider.model);
  }

  function setComposerBusy(busy) {
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

  clearChat.addEventListener('click', (e) => {
    e.preventDefault();
    messages = [];
    saveMessages(messages);
    renderMessages();
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
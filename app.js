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

  // When true, chat calls the backend /api/chat. When false (default), the
  // local mock replies so the UI works with zero backend running.
  const USE_BACKEND = false;
  const BACKEND_CHAT_URL = '/api/chat';

  // Built-in local provider (no key required). Serves as the default.
  const LOCAL_PROVIDER = {
    id: 'local',
    name: 'Local (mock)',
    baseUrl: '',
    apiKey: '',
    model: 'mock',
    builtin: true,
  };

  let providers = loadProviders();
  let activeId = localStorage.getItem(STORAGE_KEYS.activeId) || 'local';

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  function loadProviders() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.providers);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length) return [LOCAL_PROVIDER, ...parsed.filter((p) => p && p.id !== 'local')];
    } catch (err) {
      // Swallow corrupt data; start fresh. Never log the raw value (may contain keys).
      console.warn('Could not read saved providers; resetting.');
    }
    return [LOCAL_PROVIDER];
  }

  function saveProviders() {
    // Never persist the builtin local provider, and never log key contents.
    const custom = providers.filter((p) => !p.builtin);
    localStorage.setItem(STORAGE_KEYS.providers, JSON.stringify(custom));
  }

  function loadMessages() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.messages);
      return raw ? JSON.parse(raw) : [];
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
  const removeProvider = $('#removeProvider');
  const activeModel = $('#activeModel');
  const chatStatus = $('#chatStatus');
  const messagesEl = $('#messages');
  const composer = $('#composer');
  const input = $('#input');
  const clearChat = $('#clearChat');

  // ---------------------------------------------------------------------------
  // Provider selector
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
  }

  function syncHeader() {
    const p = getActiveProvider();
    activeModel.textContent = p.builtin ? p.name : `${p.name} · ${p.model}`;
    chatStatus.textContent = p.builtin
      ? 'offline · mock mode'
      : `${p.model} · BYOK ready (backend call is stubbed)`;
    removeProvider.hidden = !!p.builtin;
  }

  providerSelect.addEventListener('change', () => {
    activeId = providerSelect.value;
    localStorage.setItem(STORAGE_KEYS.activeId, activeId);
    syncHeader();
  });

  // ---------------------------------------------------------------------------
  // Provider form (BYOK)
  // ---------------------------------------------------------------------------

  providerForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const name = $('#provName').value.trim();
    const baseUrl = $('#provBaseUrl').value.trim();
    const apiKey = $('#provApiKey').value.trim();
    const model = $('#provModel').value.trim();

    if (!name || !baseUrl || !apiKey || !model) return;

    const id = 'prov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    providers.push({ id, name, baseUrl, apiKey, model, builtin: false });
    saveProviders();

    activeId = id;
    localStorage.setItem(STORAGE_KEYS.activeId, activeId);

    providerForm.reset();
    providerFormWrap.open = false;
    renderProviderSelect();
  });

  removeProvider.addEventListener('click', () => {
    const p = getActiveProvider();
    if (!p || p.builtin) return;
    providers = providers.filter((x) => x.id !== p.id);
    activeId = 'local';
    localStorage.setItem(STORAGE_KEYS.activeId, activeId);
    saveProviders();
    renderProviderSelect();
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

  function localMockReply(userText, provider) {
    if (provider.builtin) {
      return (
        '[mock] I\'m a local echo — no backend running. ' +
        'You said: "' + userText.slice(0, 300) + '"\n\n' +
        'Add a BYOK provider or run the backend, then flip USE_BACKEND=true in app.js to get real replies.'
      );
    }
    return (
      '[mock] Using provider "' + provider.name + '" (' + provider.model + ').\n\n' +
      'You said: "' + userText.slice(0, 300) + '"\n\n' +
      'This is a stubbed reply. Set USE_BACKEND=true in app.js and run the backend to route requests to ' +
      provider.baseUrl + ' with your key.'
    );
  }

  // ---- Backend hook (ready, but unused while USE_BACKEND = false) ----
  // Sends the active BYOK provider config + messages to POST /api/chat.
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
    setComposerBusy(true);

    let reply;
    try {
      if (USE_BACKEND) {
        // Real path: proxy through the backend so the key never leaves the browser unencrypted in this flow.
        reply = await callBackend(provider, messages);
      } else {
        // Simulate network latency so the UI feels real.
        await new Promise((r) => setTimeout(r, 350));
        reply = localMockReply(text, provider);
      }
    } catch (err) {
      reply = '⚠️ Error: ' + (err && err.message ? err.message : err);
    } finally {
      setComposerBusy(false);
    }

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

  // Auto-grow textarea.
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
  // MCP status placeholder (skeleton — backend bridge is TODO)
  // ---------------------------------------------------------------------------

  const mcpStatusText = $('#mcpStatusText');
  const mcpDot = $('#mcpDot');
  // Nothing to connect yet; this is where the backend MCP bridge status will live.
  mcpStatusText.textContent = 'Not connected — backend MCP bridge is TODO';
  mcpDot.className = 'dot dot--offline';

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

  // Mobile sidebar toggle.
  const sidebar = $('#sidebar');
  $('#openSidebar').addEventListener('click', () => sidebar.classList.add('sidebar--open'));
  $('#closeSidebar').addEventListener('click', () => sidebar.classList.remove('sidebar--open'));
})();
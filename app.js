/* AI Agent — frontend logic (no build step, vanilla JS).
 * 3D phone "Control Center" on top of the existing BYOK chat + PWA plumbing.
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
    history: 'aiAgent.history',
    gallery: 'aiAgent.gallery',
  };

  const USE_BACKEND = true;
  const BACKEND_BASE = 'https://ai-agent-backend.ai-agent-backend.workers.dev';
  const BACKEND_CHAT_URL = BACKEND_BASE + '/api/chat';
  const BACKEND_DEVICES_URL = BACKEND_BASE + '/api/devices';
  // Direct raw-relay command endpoint. New contract: POST /api/command returns
  // { ok, command_id } immediately, then GET /api/result?id=<command_id> polls
  // until { ok, result } is ready (or { ok: false, pending: true } meanwhile).
  const BACKEND_COMMAND_URL = BACKEND_BASE + '/api/command';
  const BACKEND_RESULT_URL = BACKEND_BASE + '/api/result';
  const BACKEND_LOCATION_URL = BACKEND_BASE + '/api/location_history';
  const BACKEND_SCHEDULE_URL = BACKEND_BASE + '/api/schedule';
  const BACKEND_NOTIF_URL = BACKEND_BASE + '/api/notif_stream';

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

  // ---------------------------------------------------------------------------
  // Control Center TOOLS — single source of truth (emoji + relay command map).
  // `build(scope)` renders that tool's controls; `scope` = { controls, result,
  // run(command, kind), runMulti([{cmd,label}]) }.
  // ---------------------------------------------------------------------------
  const TOOLS = [
    {
      id: 'camera', emoji: '📷', label: 'Camera', sub: 'Back / front photo', color: '#4f8cff',
      build(scope) {
        scope.controls.appendChild(el('span', 'tool-controls__label', 'Lens'));
        let lens = 'back';
        const back = makeButton('🔘 Back', () => setLens('back'));
        const front = makeButton('🔘 Front', () => setLens('front'));
        function setLens(l) {
          lens = l;
          back.classList.toggle('tc-btn--active', l === 'back');
          front.classList.toggle('tc-btn--active', l === 'front');
        }
        setLens('back');
        scope.controls.appendChild(back);
        scope.controls.appendChild(front);
        scope.controls.appendChild(
          makeButton('📸 Capture', () => scope.run('camera_link ' + lens, 'image'), 'tc-btn tc-btn--primary')
        );
      },
    },
    {
      id: 'screenshot', emoji: '📸', label: 'Screenshot', sub: 'Snap the screen', color: '#4f8cff',
      build(scope) {
        scope.controls.appendChild(
          makeButton('📸 Capture', () => scope.run('screenshot_link', 'image'), 'tc-btn tc-btn--primary')
        );
      },
    },
    {
      id: 'audio', emoji: '🎤', label: 'Audio', sub: 'Record mic · WAV', color: '#ff6b6b',
      build(scope) {
        scope.controls.appendChild(el('span', 'tool-controls__label', 'Duration (seconds)'));
        const seg = makeSeg(['10', '30', '60'], 0);
        scope.controls.appendChild(seg.wrap);
        scope.controls.appendChild(
          makeButton('🔴 Record', () => scope.run('record_audio ' + seg.value, 'audio'), 'tc-btn tc-btn--danger')
        );
      },
    },
    {
      id: 'screenrecord', emoji: '🎥', label: 'Screen Record', sub: 'Record the screen', color: '#ff8f6b',
      build(scope) {
        scope.controls.appendChild(el('span', 'tool-controls__label', 'Duration (seconds)'));
        const seg = makeSeg(['10', '30', '60'], 0);
        scope.controls.appendChild(seg.wrap);
        scope.controls.appendChild(
          makeButton('⏺ Record', () => scope.run('screen_record_link ' + seg.value, 'video'), 'tc-btn tc-btn--primary')
        );
      },
    },
    {
      id: 'location', emoji: '📍', label: 'Location', sub: 'GPS + maps link', color: '#3fb96a',
      build(scope) {
        scope.controls.appendChild(
          makeButton('🗺 Get location', () => scope.run('location', 'link'), 'tc-btn tc-btn--primary')
        );
      },
    },
    {
      id: 'tap', emoji: '👆', label: 'Tap', sub: 'Tap by % coords', color: '#8b5cf6',
      build(scope) {
        const x = makeInput('number', 'X (0-100)', 50);
        const y = makeInput('number', 'Y (0-100)', 50);
        scope.controls.appendChild(makeField('X %', x));
        scope.controls.appendChild(makeField('Y %', y));
        scope.controls.appendChild(
          makeButton('👆 Tap %', () => {
            const xv = clamp(x.value, 0, 100);
            const yv = clamp(y.value, 0, 100);
            if (isNaN(xv) || isNaN(yv)) { toast('X and Y must be numbers (0-100)'); return; }
            scope.run('tap_percent ' + xv + ' ' + yv);
          }, 'tc-btn tc-btn--primary')
        );
        scope.controls.appendChild(makeButton('📐 Get screen size', () => scope.run('screen_size'), 'tc-btn'));
      },
    },
    {
      id: 'sms', emoji: '💬', label: 'SMS', sub: 'Read & send texts', color: '#38b2ac',
      build(scope) {
        scope.controls.appendChild(el('span', 'tool-controls__label', 'Read inbox'));
        const count = makeInput('number', 'Count (e.g. 5)', 5);
        scope.controls.appendChild(makeField('Count', count));
        scope.controls.appendChild(
          makeButton('📖 Read', () => scope.run('smsread ' + (parseInt(count.value, 10) || 5)), 'tc-btn')
        );

        scope.controls.appendChild(el('span', 'tool-controls__label', 'Compose & send'));
        const number = makeInput('tel', 'Phone number', '');
        const msg = makeInput('text', 'Message', '');
        scope.controls.appendChild(makeField('Number', number));
        scope.controls.appendChild(makeField('Message', msg));
        scope.controls.appendChild(
          makeButton('📤 Send', () => {
            const n = number.value.trim();
            const m = msg.value.trim();
            if (!n || !m) { toast('Enter a phone number and a message'); return; }
            scope.run('smssend ' + n + ' ' + m);
          }, 'tc-btn tc-btn--primary')
        );
      },
    },
    {
      id: 'calllog', emoji: '📞', label: 'Call Log', sub: 'Recent calls', color: '#7aa5ff',
      build(scope) {
        const count = makeInput('number', 'Count (e.g. 5)', 5);
        scope.controls.appendChild(makeField('Count', count));
        scope.controls.appendChild(
          makeButton('📖 Read', () => scope.run('calllog ' + (parseInt(count.value, 10) || 5)), 'tc-btn tc-btn--primary')
        );
      },
    },
    {
      id: 'contacts', emoji: '👤', label: 'Contacts', sub: 'Search contacts', color: '#8b5cf6',
      build(scope) {
        const name = makeInput('text', 'Name to search', '');
        scope.controls.appendChild(makeField('Name', name));
        scope.controls.appendChild(
          makeButton('🔍 Find', () => {
            const q = name.value.trim();
            if (!q) { toast('Enter a contact name to search'); return; }
            scope.run('findcontact ' + q);
          }, 'tc-btn tc-btn--primary')
        );
      },
    },
    {
      id: 'files', emoji: '📁', label: 'Files', sub: 'Get / put files', color: '#f2b13c',
      build(scope) {
        const gLabel = el('span', 'tool-controls__label', 'Download from phone (get)');
        const gPath = makeInput('text', '/sdcard/Download/file.txt', '');
        scope.controls.appendChild(gLabel);
        scope.controls.appendChild(makeField('Path', gPath));
        scope.controls.appendChild(
          makeButton('⬇ Get', () => {
            const p = gPath.value.trim();
            if (!p) { toast('Enter a file path'); return; }
            scope.run('file_get ' + p);
          }, 'tc-btn')
        );

        const pLabel = el('span', 'tool-controls__label', 'Upload to phone (put)');
        const pPath = makeInput('text', '/sdcard/Download/file.txt', '');
        const pContent = el('textarea');
        pContent.placeholder = 'File content…';
        pContent.rows = 2;
        scope.controls.appendChild(pLabel);
        scope.controls.appendChild(makeField('Path', pPath));
        scope.controls.appendChild(makeField('Content', pContent));
        scope.controls.appendChild(
          makeButton('⬆ Put', () => {
            const path = pPath.value.trim();
            if (!path) { toast('Enter a destination path'); return; }
            scope.run('file_put ' + path + ' ' + utf8ToBase64(pContent.value));
          }, 'tc-btn')
        );
      },
    },
    {
      id: 'live', emoji: '📺', label: 'Live Screen', sub: 'Mirror the screen', color: '#38b2ac',
      build(scope) {
        scope.controls.appendChild(makeButton('▶ Start', () => scope.run('live start', 'link'), 'tc-btn'));
        scope.controls.appendChild(makeButton('⏹ Stop', () => scope.run('live stop'), 'tc-btn'));
        scope.controls.appendChild(makeButton('📊 Status', () => scope.run('live status', 'link'), 'tc-btn'));
      },
    },
    {
      id: 'notifs', emoji: '🔔', label: 'Notifications', sub: 'Read phone notifs', color: '#f2b13c',
      build(scope) {
        const count = makeInput('number', 'Count (e.g. 10)', 10);
        scope.controls.appendChild(makeField('Count', count));
        scope.controls.appendChild(
          makeButton('📖 Read', () => scope.run('notifs ' + (parseInt(count.value, 10) || 10)), 'tc-btn tc-btn--primary')
        );
      },
    },
    {
      id: 'lifelog', emoji: '📜', label: 'Life Log', sub: 'Start · read · stats', color: '#8b5cf6',
      build(scope) {
        scope.controls.appendChild(makeButton('▶ Start', () => scope.run('lifelog start'), 'tc-btn'));
        scope.controls.appendChild(makeButton('⏹ Stop', () => scope.run('lifelog stop'), 'tc-btn'));
        const count = makeInput('number', 'Last N events (e.g. 20)', 20);
        scope.controls.appendChild(makeField('Events', count));
        scope.controls.appendChild(
          makeButton('📖 Read', () => scope.run('lifelog read public last ' + (parseInt(count.value, 10) || 20)), 'tc-btn tc-btn--primary')
        );
        scope.controls.appendChild(makeButton('📊 Stats', () => scope.run('lifelog stats'), 'tc-btn'));
      },
    },
    {
      id: 'battery', emoji: '🔋', label: 'Battery / Info', sub: 'Device details', color: '#3fb96a',
      build(scope) {
        scope.controls.appendChild(
          makeButton('🔋 Get device info', () => scope.runMulti([
            { cmd: 'battery', label: '🔋 Battery' },
            { cmd: 'deviceinfo', label: '📱 Device info' },
          ]), 'tc-btn tc-btn--primary')
        );
      },
    },
    {
      id: 'status', emoji: '📊', label: 'All Status', sub: 'Battery · storage · net', color: '#4f8cff',
      build(scope) {
        scope.controls.appendChild(
          makeButton('📊 Get all', () => scope.runMulti([
            { cmd: 'battery', label: '🔋 Battery' },
            { cmd: 'storage', label: '💾 Storage' },
            { cmd: 'network', label: '📶 Network' },
            { cmd: 'deviceinfo', label: '📱 Device info' },
          ]), 'tc-btn tc-btn--primary')
        );
      },
    },
  ];

  let providers = loadProviders();
  let activeId = localStorage.getItem(STORAGE_KEYS.activeId) || 'local';
  let editingId = null; // provider id being edited (null = adding new)

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  // Shared-secret web key for the backend's sensitive endpoints. The worker is
  // FAIL-CLOSED: if `AGENT_WEB_KEY` is unset/blank on the worker every protected
  // request is denied (401), including one sent with the correct key. The key
  // must therefore actually be set as a Cloudflare secret AND the worker must be
  // (re)deployed with that secret for unlocks to succeed.
  //
  // SECURITY note (deliberate trade-off): this value must persist in
  // localStorage so it can back the `X-Web-Key` header on every fetch. That
  // means any script running on this origin could in principle read it, which is
  // exactly why the rest of this file never places untrusted (SMS / contacts /
  // notifications / command results / chat) data into `innerHTML` — see
  // `renderToolResult` (textContent-based) and `linkify` (every segment is HTML-
  // escaped). It is stored in this one key only, never duplicated anywhere else.
  // BYOK `providers[].apiKey` values live in localStorage (`saveProviders`) for
  // the same reason: they must survive reloads, so the same XSS-hardening
  // invariant is what keeps them from being exfiltrated.
  function agentWebKey() {
    try { return localStorage.getItem('agentWebKey') || ''; } catch { return ''; }
  }

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
    try { localStorage.setItem(STORAGE_KEYS.providers, JSON.stringify(custom)); }
    catch (err) { /* quota exceeded / storage blocked — swallow */ }
  }

  function loadMessages() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.messages)) || [];
    } catch {
      return [];
    }
  }

  function saveMessages(messages) {
    try {
      // Cap to the most recent ~200 messages so localStorage never overflows.
      const capped = Array.isArray(messages) ? messages.slice(-200) : [];
      localStorage.setItem(STORAGE_KEYS.messages, JSON.stringify(capped));
    } catch (err) { /* quota exceeded / storage blocked — swallow */ }
  }

  // Non-throwing localStorage helpers (storage can be blocked / full in some
  // browsers or private windows).
  function trySetItem(key, value) {
    try { localStorage.setItem(key, value); } catch (err) { /* ignore */ }
  }
  function tryRemoveItem(key) {
    try { localStorage.removeItem(key); } catch (err) { /* ignore */ }
  }

  // --------------------------------------------------------------------------
  // Feature #8 — command history (persisted, capped ~100 entries).
  // --------------------------------------------------------------------------
  let commandHistory = loadHistory();

  function loadHistory() {
    try {
      const arr = JSON.parse(localStorage.getItem(STORAGE_KEYS.history));
      return Array.isArray(arr) ? arr.slice(0, 100) : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(commandHistory.slice(0, 100)));
    } catch { /* ignore */ }
  }

  function toolFromCommand(command) {
    return String(command || '').trim().split(/\s+/)[0] || 'cmd';
  }

  function pushHistory(tool, command, resultText) {
    let cmdStr = String(command || '');
    const t = tool || toolFromCommand(cmdStr);
    // Don't persist file_put base64 payloads in history (large / sensitive).
    if (t === 'file_put') {
      cmdStr = cmdStr.replace(/^(file_put\s+\S+\s+)\S+$/i, '$1(data)');
    }
    commandHistory.unshift({
      ts: Date.now(),
      tool: t,
      command: cmdStr,
      result_snippet: String(resultText || '').slice(0, 160),
    });
    if (commandHistory.length > 100) commandHistory.length = 100;
    saveHistory();
  }

  function clearHistory() {
    commandHistory = [];
    saveHistory();
  }

  // --------------------------------------------------------------------------
  // Feature #2 — media gallery (persisted, capped ~60 items; URLs only).
  // --------------------------------------------------------------------------
  let mediaGallery = loadGallery();

  function loadGallery() {
    try {
      const arr = JSON.parse(localStorage.getItem(STORAGE_KEYS.gallery));
      return Array.isArray(arr) ? arr.slice(0, 60) : [];
    } catch {
      return [];
    }
  }

  // Persist gallery but NEVER store base64 / data URIs (only http(s) URLs).
  function saveGallery() {
    try {
      const persist = mediaGallery
        .filter((g) => g && typeof g.url === 'string' && !/^data:/i.test(g.url))
        .slice(0, 60);
      localStorage.setItem(STORAGE_KEYS.gallery, JSON.stringify(persist));
    } catch { /* ignore */ }
  }

  function addToGallery(type, url) {
    if (!url || typeof url !== 'string') return;
    const clean = url.trim();
    if (!clean) return;
    mediaGallery.unshift({ ts: Date.now(), type: type || 'image', url: clean });
    if (mediaGallery.length > 60) mediaGallery.length = 60;
    saveGallery();
  }

  // Infer a render `kind` from a raw command string (used for History "Rerun").
  function kindForCommand(command) {
    const c = String(command || '').toLowerCase();
    if (c.indexOf('screen_record') === 0) return 'video';
    if (c.indexOf('record_audio') === 0) return 'audio';
    if (c.indexOf('camera_link') === 0 || c.indexOf('screenshot_link') === 0) return 'image';
    if (c.indexOf('live ') === 0 || c.indexOf('location') === 0) return 'link';
    return 'auto';
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

  // Control Center DOM refs
  const gridView = $('#gridView');
  const toolView = $('#toolView');
  const tileGrid = $('#tileGrid');
  const toolTitle = $('#toolTitle');
  const toolControlsEl = $('#toolControls');
  const toolResultEl = $('#toolResult');
  const backBtn = $('#backBtn');
  const ccMain = $('.cc-main');
  const chatPanel = $('#chatPanel');
  const chatScrim = $('#chatScrim');
  const chatToggle = $('#chatToggle');
  const closeChat = $('#closeChat');

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
    trySetItem(STORAGE_KEYS.activeId, activeId);
    renderProviderSelect();
    setFormMode('edit');
  }

  function deleteProvider(id) {
    const p = providers.find((x) => x.id === id);
    if (!p || p.builtin) return;
    providers = providers.filter((x) => x.id !== id);
    if (activeId === id) activeId = 'local';
    trySetItem(STORAGE_KEYS.activeId, activeId);
    if (editingId === id) setFormMode('add');
    saveProviders();
    renderProviderSelect();
  }

  providerSelect.addEventListener('change', () => {
    activeId = providerSelect.value;
    trySetItem(STORAGE_KEYS.activeId, activeId);
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
    trySetItem(STORAGE_KEYS.activeId, activeId);
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
  // Relay media links (gokul-agent-server.onrender.com/media/<id>) have no file
  // extension, so they're missed by MEDIA_EXT_RE. The generic /media/<id> form
  // covers both the relay host and any equivalent path.
  const RELAY_MEDIA_RE = /(?:gokul-agent-server\.onrender\.com)?\/media\/[A-Za-z0-9_-]+/i;

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
    return MEDIA_EXT_RE.test(url) || TELEGRAM_FILE_RE.test(url) || RELAY_MEDIA_RE.test(url);
  }

  function mediaTypeFromUrl(url) {
    return /\.(?:mp4|mov|webm|m4v)(?:[?#]|$)/i.test(url) ? 'video' : 'image';
  }

  function cleanUrl(url) {
    return url.replace(/[.,;:!?'")\]}>]+$/, '');
  }

  // Only allow http(s) media / download URLs. This blocks `javascript:`,
  // `data:`, `blob:` etc. from ever being assigned to <img>/<video>/<a> src/href
  // (media links and download buttons are built from relay/backend strings that
  // should never be trusted verbatim). Kept to the http(s) scheme gate rather
  // than a strict host allowlist so arbitrary relay hosts / GitHub / Telegram
  // media links keep working.
  function safeMediaUrl(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) return '';
    return u;
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
    const url = safeMediaUrl(item.url);

    let mediaEl;
    if (item.type === 'video') {
      mediaEl = document.createElement('video');
      mediaEl.controls = true;
      mediaEl.preload = 'metadata';
      mediaEl.playsInline = true;
      mediaEl.src = url;
    } else {
      mediaEl = document.createElement('img');
      mediaEl.loading = 'lazy';
      mediaEl.alt = 'Media';
      mediaEl.src = url;
      // Telegram serves files as application/octet-stream; re-fetch as a Blob
      // with a sniffed mime so the <img> renders inline instead of downloading.
      renderImageViaBlob(mediaEl, url);
    }
    mediaEl.className = 'msg__media-el';

    const dl = document.createElement('a');
    dl.className = 'msg__media-dl';
    dl.href = url;
    dl.target = '_blank';
    dl.rel = 'noopener noreferrer';
    dl.download = '';
    dl.textContent = '⬇ Download';

    box.appendChild(mediaEl);
    box.appendChild(dl);
    return box;
  }

  // Fetch an image URL, sniff its real mime from the bytes, and set the <img>
  // src to a Blob object URL so an octet-stream response still renders inline.
  function renderImageViaBlob(img, url) {
    url = safeMediaUrl(url);
    if (!url) return;
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
        const next = URL.createObjectURL(blob);
        if (img._blobUrl) { try { URL.revokeObjectURL(img._blobUrl); } catch (e) { /* ignore */ } }
        img._blobUrl = next;
        img.src = next;
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
    if (activeSpeaker === btn) {
      speechSynthesis.cancel();
      return;
    }
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

  function classifyError(status, detail) {
    const d = String(detail || '').toLowerCase();
    if (status === 401 || status === 403) return 'auth';
    if (/api\s?key|credential|unauthor|authentication|\bauth\b/.test(d)) return 'auth';
    if (/\b(?:invalid|unknown|unsupported|not\s+found|does\s+not\s+exist|no\s+such)\s+(?:model|model\s+id)\b|\bmodel\b\s+(?:invalid|unknown|unsupported|not\s+found|does\s+not\s+exist)/.test(d)) return 'model';
    if (status >= 500) return 'backend';
    if (status >= 400) return 'provider';
    return 'unknown';
  }

  function formatError(err) {
    const prefixes = {
      network: '🔌 Backend unreachable',
      timeout: '⏳ Request timed out',
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

  const CHAT_TIMEOUT_MS = 180000;

  // Human-readable labels for the dangerous phone tools used in the confirm
  // prompt ("Allow <tool>? (<label>)"). Mirrors the worker's DANGEROUS_TOOLS set.
  const DANGEROUS_TOOL_LABELS = {
    phone_tap_percent: 'tap the phone screen',
    record_screen: 'record the phone screen',
    read_sms: 'read your SMS messages',
    read_call_log: 'read your call log',
    take_photo: 'take a photo with the phone camera',
  };

  async function callBackend(provider, msgs, confirmedTools) {
    let res;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      res = await fetch(BACKEND_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Web-Key': agentWebKey() },
        body: JSON.stringify({
          provider: {
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: provider.model,
          },
          messages: msgs.map(({ role, content }) => ({ role, content })),
          ...(selectedDeviceId ? { device_id: selectedDeviceId } : {}),
          ...(confirmedTools ? { confirmed_tools: true } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw errWithKind(
          'timeout',
          'The request took longer than 3 minutes — the tool loop may still be running. Please try again.'
        );
      }
      throw errWithKind('network', (err && err.message) ? err.message : 'Failed to fetch');
    } finally {
      clearTimeout(timeoutId);
    }

    let data = null;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      if (data && data.rate_limited) {
        return { rateLimited: true, retryAfter: data.retry_after || 60, error: data.error };
      }
      const detail = (data && (data.error || data.message)) || ('HTTP ' + res.status);
      throw errWithKind(classifyError(res.status, detail), String(detail));
    }

    const reply = (data && data.reply && data.reply.content) || '(no content)';
    const tools = data && Array.isArray(data.tools_used) ? data.tools_used : [];
    const media = data && Array.isArray(data.media) ? data.media : [];
    const pendingConfirmation = data && data.pending_confirmation ? data.pending_confirmation : null;
    return { content: reply, tools, media, rateLimited: false, pendingConfirmation };
  }

  let isBusy = false;

  function countdownForRetry(seconds, thinkingEl) {
    let remaining = seconds;
    const bubble = thinkingEl && thinkingEl.querySelector('.msg__bubble');
    const meta = thinkingEl && thinkingEl.querySelector('.msg__meta');
    return new Promise((resolve) => {
      const tick = () => {
        if (bubble) {
          bubble.innerHTML = '';
          const label = document.createElement('span');
          label.className = 'counting-label';
          label.textContent = '⏳ Rate limit — ' + remaining + 's la auto-retry…';
          bubble.appendChild(label);
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
    if (isBusy) return;

    const text = input.value.trim();
    if (!text) return;

    const provider = getActiveProvider();

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

    const history = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.trim())
      .map(({ role, content }) => ({ role, content }));

    if (!history.length) {
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
        let confirmedTools = false;
        let attempt = 0;
        while (true) {
          const result = await callBackend(provider, history, confirmedTools);

          // Dangerous-phone-tool confirmation gate: the model asked to run a
          // sensitive tool. Ask the user, then re-send the SAME conversation
          // (with `confirmed_tools: true`, or a "user denied" note).
          if (result.pendingConfirmation) {
            const toolName = result.pendingConfirmation;
            const desc = DANGEROUS_TOOL_LABELS[toolName] || toolName;
            const allow = window.confirm('Allow "' + toolName + '" (' + desc + ')?\n\nOK = Yes · Cancel = No');
            if (allow) {
              confirmedTools = true;
            } else {
              addMessage('user', 'user denied', provider.model);
              history.push({ role: 'user', content: 'user denied' });
              confirmedTools = false;
            }
            continue; // confirmation does not count as a rate-limit attempt
          }

          if (!result.rateLimited) {
            reply = result.content;
            toolsUsed = Array.isArray(result.tools) ? result.tools : [];
            mediaUsed = Array.isArray(result.media) ? result.media : [];
            ok = true;
            break;
          }

          attempt += 1;
          if (attempt >= 3) {
            reply = '⏳ Rate limit innum irukku — konjam neram wait pannu, appuram try pannu.';
            break;
          }
          await countdownForRetry(Math.min(result.retryAfter || 60, 300), thinkingEl);
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
        input.focus();
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
  let devicesCache = [];

  // Human-friendly device display name. Devices can report `name` / `model` as
  // null/empty, so we never surface a bare "?" or a long raw `dev-…` id: prefer
  // name → model → "Phone …<short-id>" → "Unnamed phone".
  function deviceIdOf(d) {
    return (d && (d.device_id || d.id) && String(d.device_id || d.id).trim()) || '';
  }

  function shortDeviceId(id) {
    const s = String(id || '').trim();
    return s.length > 8 ? '…' + s.slice(-8) : s;
  }

  function friendlyDeviceName(d) {
    const name = (d && typeof d.name === 'string') ? d.name.trim() : '';
    const model = (d && typeof d.model === 'string') ? d.model.trim() : '';
    if (name) return name;
    if (model) return model;
    const id = deviceIdOf(d);
    return id ? 'Phone ' + shortDeviceId(id) : 'Unnamed phone';
  }

  function populateDeviceSelect(devices) {
    devicesCache = devices || [];
    if (deviceSelect) {
      const prev = selectedDeviceId;
      deviceSelect.innerHTML = '';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = '📱 Auto device';
      deviceSelect.appendChild(auto);
      devicesCache.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.device_id || d.id || '';
        opt.textContent = (d.online ? '● ' : '○ ') + friendlyDeviceName(d);
        deviceSelect.appendChild(opt);
      });
      deviceSelect.value = prev;
      if (deviceSelect.value !== prev && prev) {
        selectedDeviceId = '';
        tryRemoveItem('aiAgent.deviceId');
      }
    }
    updateStatusDevice();
  }

  // Bottom status-bar dot + device label.
  function updateStatusDevice() {
    const dot = document.getElementById('statusDot');
    const label = document.getElementById('statusDevice');
    if (!dot) return;
    const online = devicesCache.filter((d) => d.online);
    const selected = selectedDeviceId
      ? devicesCache.find((d) => (d.device_id || d.id) === selectedDeviceId)
      : null;
    const device = selected || online[0] || null;
    if (device) {
      dot.className = device.online ? 'dot dot--online' : 'dot dot--offline';
      if (label) label.textContent = friendlyDeviceName(device);
    } else {
      dot.className = 'dot dot--offline';
      if (label) label.textContent = devicesCache.length ? 'phone offline' : 'no phone';
    }
  }

  if (deviceSelect) {
    deviceSelect.addEventListener('change', () => {
      selectedDeviceId = deviceSelect.value;
      if (selectedDeviceId) trySetItem('aiAgent.deviceId', selectedDeviceId);
      else tryRemoveItem('aiAgent.deviceId');
      updateStatusDevice();
      refreshStatusBar();
    });
  }

  async function refreshMcpStatus() {
    try {
      const devices = await fetchDevices();
      populateDeviceSelect(devices);
      const online = devices.filter((d) => d.online);
      if (online.length) {
        const names = online.map((d) => friendlyDeviceName(d)).join(', ');
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

  // ---------------------------------------------------------------------------
  // Control Center — DOM helpers (tiny, dependency-free)
  // ---------------------------------------------------------------------------

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  function makeInput(type, placeholder, value) {
    const inp = el('input');
    inp.type = type || 'text';
    if (placeholder) inp.placeholder = placeholder;
    if (value != null) inp.value = value;
    return inp;
  }

  function makeField(labelText, inputEl) {
    const f = el('label', 'field');
    f.appendChild(el('span', 'field__label', labelText));
    f.appendChild(inputEl);
    return f;
  }

  function makeButton(label, onClick, className) {
    const b = el('button', className || 'tc-btn', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // Segmented control: a row of mutually-exclusive buttons (e.g. durations).
  function makeSeg(labels, initialIndex, onChange) {
    const wrap = el('div', 'seg');
    const btns = [];
    let current = initialIndex || 0;
    function update() {
      btns.forEach((b, i) => b.classList.toggle('tc-btn--active', i === current));
    }
    labels.forEach((lbl, i) => {
      const b = makeButton(lbl, () => {
        current = i;
        update();
        if (onChange) onChange(labels[i]);
      });
      btns.push(b);
      wrap.appendChild(b);
    });
    update();
    return { wrap, get value() { return labels[current]; } };
  }

  function clamp(v, min, max) {
    const n = parseFloat(v);
    if (isNaN(n)) return NaN;
    return Math.max(min, Math.min(max, n));
  }

  // UTF-8 → base64 (safe for non-Latin1 files PUT to the phone).
  function utf8ToBase64(str) {
    try {
      const bytes = new TextEncoder().encode(String(str));
      let bin = '';
      bytes.forEach((b) => { bin += String.fromCharCode(b); });
      return btoa(bin);
    } catch (e) {
      try { return btoa(String(str)); } catch (e2) { return ''; }
    }
  }

  // ---------------------------------------------------------------------------
  // Control Center — command execution + result rendering
  // ---------------------------------------------------------------------------

  const AUDIO_B64_RE = /^AUDIO_B64:/i;
  const MEDIA_LINK_RE = /MEDIA_LINK:\s*(\S+)/i;
  const URL_RE = /https?:\/\/[^\s"'<>]+/i;
  const MAPS_RE = /(?:maps\.google\.com|google\.com\/maps|goo\.gl\/maps|maps\.app\.goo\.gl)/i;

  let ccBusy = false;

  // Command execution is two-phase with the new backend contract:
  //   POST /api/command  -> { ok, command_id } immediately (or { ok, result } if
  //                          it was already done),
  //   GET  /api/result?id=<command_id> -> { ok, result } when ready, or
  //                          { ok:false, pending:true } meanwhile.
  // We poll every ~2s for up to ~70s, and fall back to a directly embedded
  // `result` field when present (backward-compatible with the old contract).
  const COMMAND_TIMEOUT_MS = 130000;
  const COMMAND_POLL_MS = 2000;

  // `deviceId` is an optional per-call override for multi-device control; when
  // omitted it falls back to `selectedDeviceId` (the header device selector).
  // `opts.log === false` suppresses command-history logging (used by background
  // status polling so it doesn't flood the history).
  async function postCommand(command, deviceId, opts) {
    let targetDevice = deviceId || selectedDeviceId;
    if (!targetDevice) {
      try { targetDevice = await resolveOnlineTargetId(); } catch (err) { targetDevice = ''; }
    }
    const log = !opts || opts.log !== false;
    let data = null;
    let errorDetail = '';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch(BACKEND_COMMAND_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Web-Key': agentWebKey() },
          body: JSON.stringify({
            command: command,
            ...(targetDevice ? { device_id: targetDevice } : {}),
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          errorDetail = 'Timed out';
          throw errWithKind('timeout', errorDetail);
        }
        errorDetail = 'Backend unreachable';
        throw errWithKind('network', errorDetail);
      }

      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        errorDetail = (data && (data.error || data.message || data.result)) || ('HTTP ' + res.status);
        if (res.status === 401 || res.status === 403) {
          errorDetail = 'Invalid security key';
          throw errWithKind('auth', errorDetail);
        }
        throw errWithKind(classifyError(res.status, errorDetail), errorDetail);
      }

      // Backward-compatible: the response already carries the final result.
      if (data && typeof data.result !== 'undefined') return data;

      // New contract: poll /api/result until the command is ready.
      const commandId = data && (data.command_id || data.result_id || data.id);
      if (commandId) {
        const pollUrl = BACKEND_RESULT_URL + '?id=' + encodeURIComponent(commandId);
        for (;;) {
          await new Promise((r) => setTimeout(r, COMMAND_POLL_MS));
          let pres = null;
          try {
            const pollRes = await fetch(pollUrl, {
              headers: { 'X-Web-Key': agentWebKey() },
              signal: controller.signal,
            });
            try { pres = await pollRes.json(); } catch (e) { pres = null; }
          } catch (err) {
            if (err && err.name === 'AbortError') throw err;
            continue; // transient network error — retry next tick
          }
          if (pres && pres.ok && typeof pres.result !== 'undefined') {
            data = { result: pres.result };
            return data;
          }
          // { ok:false, pending:true } → keep polling until the timeout fires.
        }
      }
      return data;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        errorDetail = 'Timed out';
        throw errWithKind('timeout', errorDetail);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (log) {
        const snippet = errorDetail || (data && typeof data.result !== 'undefined' ? data.result : '');
        pushHistory(toolFromCommand(command), command, snippet);
      }
    }
  }

  // Non-throwing variant used by the status bar / aggregates.
  async function safeCommand(command, deviceId, opts) {
    try {
      const data = await postCommand(command, deviceId, opts);
      return (data && typeof data.result !== 'undefined') ? String(data.result) : '';
    } catch (err) {
      return null;
    }
  }

  function renderMedia(resultEl, url, kind, opts) {
    url = safeMediaUrl(url);
    if (!url) return;
    if (!(opts && opts.noGallery)) addToGallery(kind === 'video' ? 'video' : 'image', url);
    const box = el('div', 'result-media');
    if (kind === 'video') {
      const v = el('video');
      v.controls = true;
      v.preload = 'metadata';
      v.playsInline = true;
      v.src = url;
      box.appendChild(v);
    } else {
      const img = el('img');
      img.alt = 'Result';
      img.loading = 'lazy';
      renderImageViaBlob(img, url);
      box.appendChild(img);
    }
    const dl = el('a', 'result-dl', '⬇ Download');
    dl.href = url;
    dl.target = '_blank';
    dl.rel = 'noopener noreferrer';
    dl.download = '';
    box.appendChild(dl);
    resultEl.appendChild(box);
  }

  // Render a raw phone result. kind ∈ image | video | audio | link | auto.
  function renderToolResult(resultEl, raw, kind) {
    resultEl.innerHTML = '';
    const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim();
    if (!text) return;

    // 1) Audio clip (record_audio) → playable <audio> + download.
    if (AUDIO_B64_RE.test(text)) {
      const b64 = text.replace(AUDIO_B64_RE, '').replace(/\s+/g, '');
      const dataUri = 'data:audio/wav;base64,' + b64;
      addToGallery('audio', dataUri);
      const box = el('div', 'result-media');
      const audio = el('audio');
      audio.controls = true;
      audio.src = dataUri;
      const dl = el('a', 'result-dl', '⬇ Download WAV');
      dl.href = dataUri;
      dl.download = 'recording.wav';
      box.appendChild(audio);
      box.appendChild(dl);
      resultEl.appendChild(box);
      return;
    }

    // 2) Explicit media link (camera_link / screenshot_link / screen_record_link).
    const ml = text.match(MEDIA_LINK_RE);
    if (ml) {
      renderMedia(resultEl, cleanUrl(ml[1]), kind === 'video' ? 'video' : 'image');
      return;
    }

    // 3) Bare URL for a media tool.
    const bare = text.match(URL_RE);
    if (bare && (kind === 'image' || kind === 'video' || kind === 'media')) {
      renderMedia(resultEl, cleanUrl(bare[0]), kind);
      return;
    }

    // 4) Plain text (optionally + a Maps / generic link button).
    resultEl.appendChild(el('pre', 'result-pre', text));
    if (bare) {
      const url = cleanUrl(bare[0]);
      if (MAPS_RE.test(text)) {
        const m = el('a', 'result-maps', '🗺 Open in Google Maps');
        m.href = url;
        m.target = '_blank';
        m.rel = 'noopener noreferrer';
        resultEl.appendChild(m);
      } else if (kind === 'link') {
        const a = el('a', 'result-dl', '🔗 Open link');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        resultEl.appendChild(a);
      }
    }
  }

  async function runCommand(command, kind, targetEl) {
    if (ccBusy) return;
    ccBusy = true;
    const out = targetEl || toolResultEl;
    out.innerHTML = '';
    const loader = el('div', 'result-loading');
    loader.textContent = 'Running: ' + command;
    out.appendChild(loader);
    try {
      const data = await postCommand(command);
      const raw = (data && typeof data.result !== 'undefined') ? data.result : '';
      renderToolResult(out, raw, kind || 'auto');
    } catch (err) {
      const msg = formatError(err);
      out.innerHTML = '';
      out.appendChild(el('pre', 'result-pre result-error', '⚠️ ' + msg));
      toast('⚠️ ' + msg);
    } finally {
      ccBusy = false;
    }
  }

  // Run several commands in sequence and aggregate their text into one card.
  async function runMulti(list) {
    if (ccBusy) return;
    ccBusy = true;
    try {
      toolResultEl.innerHTML = '';
      const loader = el('div', 'result-loading');
      loader.textContent = 'Running ' + list.length + ' commands…';
      toolResultEl.appendChild(loader);
      const parts = [];
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        loader.textContent = 'Running: ' + it.cmd + ' (' + (i + 1) + '/' + list.length + ')';
        const raw = await safeCommand(it.cmd);
        parts.push('── ' + it.label + ' ──\n' + (raw == null ? '(request failed)' : raw));
      }
      toolResultEl.innerHTML = '';
      toolResultEl.appendChild(el('pre', 'result-pre', parts.join('\n\n')));
    } finally {
      ccBusy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Control Center — tile rendering + open/close + tilt + particles + status bar
  // ---------------------------------------------------------------------------

  let specialOnClose = null;

  function openTool(tool) {
    gridView.hidden = true;
    toolView.hidden = false;
    // Re-trigger the flip/zoom entry animation.
    toolView.style.animation = 'none';
    void toolView.offsetWidth;
    toolView.style.animation = '';
    toolTitle.textContent = tool.emoji + ' ' + tool.label;
    toolControlsEl.innerHTML = '';
    toolControlsEl.style.display = '';
    toolResultEl.innerHTML = '';
    tool.build({
      controls: toolControlsEl,
      result: toolResultEl,
      run: (command, kind) => runCommand(command, kind),
      runMulti: (list) => runMulti(list),
    });
    if (ccMain) ccMain.scrollTop = 0;
  }

  function closeTool() {
    if (specialOnClose) {
      try { specialOnClose(); } catch (err) { console.warn('view close error:', err); }
      specialOnClose = null;
    }
    toolView.hidden = true;
    gridView.hidden = false;
    toolControlsEl.style.display = '';
    gridView.style.animation = 'none';
    void gridView.offsetWidth;
    gridView.style.animation = '';
  }

  if (backBtn) backBtn.addEventListener('click', closeTool);

  // 3D tilt — rotate tiles toward the cursor (desktop only).
  function attachTilt(tile) {
    if (window.matchMedia && window.matchMedia('(hover: none)').matches) return; // mobile = float
    tile.addEventListener('mousemove', (e) => {
      const r = tile.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      tile.style.setProperty('--rx', ((0.5 - py) * 22).toFixed(2) + 'deg');
      tile.style.setProperty('--ry', ((px - 0.5) * 22).toFixed(2) + 'deg');
    });
    tile.addEventListener('mouseleave', () => {
      tile.style.setProperty('--rx', '0deg');
      tile.style.setProperty('--ry', '0deg');
    });
  }

  function buildTile(spec, onOpen) {
    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.style.setProperty('--tile-accent', spec.color || '#4f8cff');
    tile.appendChild(el('span', 'tile__emoji', spec.emoji));
    tile.appendChild(el('span', 'tile__label', spec.label));
    tile.appendChild(el('span', 'tile__sub', spec.sub));
    tile.addEventListener('click', () => onOpen(spec));
    attachTilt(tile);
    return tile;
  }

  function renderGrid() {
    tileGrid.innerHTML = '';
    TOOLS.forEach((tool, i) => {
      const tile = buildTile(tool, openTool);
      tile.style.animationDelay = (i * 30) + 'ms';
      tileGrid.appendChild(tile);
    });
    SPECIALS.forEach((spec, i) => {
      const tile = buildTile(spec, (s) => enterView(s.emoji + ' ' + s.label, s.onClose, s.build));
      tile.style.animationDelay = ((TOOLS.length + i) * 30) + 'ms';
      tileGrid.appendChild(tile);
    });
  }

  // Lightweight particle field behind the UI (skipped for reduced-motion).
  function initParticles() {
    const canvas = document.getElementById('particles');
    if (!canvas || prefersReducedMotion()) return;
    const ctx = canvas.getContext('2d');
    let w, h, dots;
    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);
    const N = Math.min(50, Math.floor(window.innerWidth / 24));
    dots = Array.from({ length: N }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.8 + 0.6,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      a: Math.random() * 0.5 + 0.15,
      hue: Math.random() < 0.5 ? 215 : 262,
    }));
    function step() {
      ctx.clearRect(0, 0, w, h);
      dots.forEach((d) => {
        d.x += d.vx; d.y += d.vy;
        if (d.x < 0) d.x = w; else if (d.x > w) d.x = 0;
        if (d.y < 0) d.y = h; else if (d.y > h) d.y = 0;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = 'hsla(' + d.hue + ', 90%, 70%, ' + d.a + ')';
        ctx.shadowBlur = 6;
        ctx.shadowColor = 'hsla(' + d.hue + ', 90%, 60%, 0.6)';
        ctx.fill();
      });
      requestAnimationFrame(step);
    }
    step();
  }

  function compact(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function summarizeBattery(text) {
    const m = String(text || '').match(/(\d{1,3})\s*%/);
    return m ? m[1] + '%' : compact(text, 12);
  }

  // Resolve the device id to actually send commands to: the selected device if
  // it's online, otherwise the first online device. Returns '' when no phone is
  // online (callers then skip the relay calls entirely rather than queueing
  // commands for an offline device).
  async function resolveOnlineTargetId() {
    let devices = devicesCache;
    if (!devices || !devices.length) {
      try { devices = await fetchDevices(); populateDeviceSelect(devices); } catch (err) { devices = devicesCache || []; }
    }
    const selected = selectedDeviceId
      ? devices.find((d) => ((d.device_id || d.id) === selectedDeviceId) && d.online)
      : null;
    const firstOnline = devices.find((d) => d.online);
    const d = selected || firstOnline;
    return d ? (d.device_id || d.id || '') : '';
  }

  // Bottom status bar: battery / storage / network quick readout.
  async function refreshStatusBar() {
    const bEl = document.getElementById('statusBattery');
    const sEl = document.getElementById('statusStorage');
    const nEl = document.getElementById('statusNetwork');
    const id = await resolveOnlineTargetId();
    if (!id) {
      // No phone is online — skip the relay calls (they would just queue up).
      if (bEl) bEl.textContent = '🔋 —';
      if (sEl) sEl.textContent = '💾 —';
      if (nEl) nEl.textContent = '📶 —';
      return;
    }
    const [battery, storage, network] = await Promise.all([
      safeCommand('battery', id, { log: false }),
      safeCommand('storage', id, { log: false }),
      safeCommand('network', id, { log: false }),
    ]);
    if (bEl) bEl.textContent = battery ? ('🔋 ' + summarizeBattery(battery)) : '🔋 —';
    if (sEl) sEl.textContent = storage ? ('💾 ' + compact(storage, 26)) : '💾 —';
    if (nEl) nEl.textContent = network ? ('📶 ' + compact(network, 22)) : '📶 —';
  }

  // ---------------------------------------------------------------------------
  // Feature #5 — multi-device dashboard (fetch shared by MCP status + Devices).
  // ---------------------------------------------------------------------------
  async function fetchDevices() {
    const res = await fetch(BACKEND_DEVICES_URL, { headers: { 'X-Web-Key': agentWebKey() } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return Array.isArray(data.devices) ? data.devices : [];
  }

  // ---------------------------------------------------------------------------
  // Feature views — a generic "special tile" entry point on top of the existing
  // tool-view shell (gridView ↔ toolView). `onClose` tears down leaky resources.
  // ---------------------------------------------------------------------------
  function enterView(title, onClose, build) {
    gridView.hidden = true;
    toolView.hidden = false;
    toolView.style.animation = 'none';
    void toolView.offsetWidth;
    toolView.style.animation = '';
    toolTitle.textContent = title;
    toolControlsEl.innerHTML = '';
    toolControlsEl.style.display = 'none'; // special views render into the result area
    toolResultEl.innerHTML = '';
    specialOnClose = onClose || null;
    if (build) {
      build({
        controls: toolControlsEl,
        result: toolResultEl,
        run: (command, kind) => runCommand(command, kind),
        runMulti: (list) => runMulti(list),
      });
    }
    if (ccMain) ccMain.scrollTop = 0;
  }

  // ---- History view (#8) ----------------------------------------------------
  function openHistory(scope) {
    if (!commandHistory.length) {
      scope.result.appendChild(el('div', 'hint', 'No commands yet — run any tool and it will show up here.'));
      return;
    }
    const box = el('div', 'history');
    box.appendChild(el('div', 'history__count', commandHistory.length + ' recent commands · stored in this browser'));
    const list = el('div', 'history__list');
    commandHistory.forEach((h) => list.appendChild(historyRow(h)));
    box.appendChild(list);
    // "Clear" affordance.
    const clear = makeButton('🗑 Clear history', () => {
      clearHistory();
      enterView('🕘 History', null, openHistory);
    }, 'tc-btn');
    box.appendChild(clear);
    scope.result.appendChild(box);
  }

  function historyRow(h) {
    const row = el('div', 'history__row');
    const top = el('div', 'history__top');
    top.appendChild(el('span', 'history__time', new Date(h.ts).toLocaleTimeString()));
    top.appendChild(el('span', 'history__tool', h.tool || 'cmd'));
    row.appendChild(top);
    row.appendChild(el('code', 'history__cmd', h.command));
    row.appendChild(el('div', 'history__preview', h.result_snippet || '(no result)'));
    row.appendChild(makeButton('🔄 Rerun', () => rerunHistory(h, row), 'tc-btn history__rerun'));
    return row;
  }

  function rerunHistory(h, row) {
    let out = row.querySelector('.history__result');
    if (!out) {
      out = el('div', 'history__result');
      row.appendChild(out);
    }
    runCommand(h.command, kindForCommand(h.command), out);
  }

  // ---- Gallery view (#2) ----------------------------------------------------
  function openGallery(scope) {
    if (!mediaGallery.length) {
      scope.result.appendChild(el('div', 'hint', 'No media yet — camera, screenshot, screen record, or audio will appear here.'));
      return;
    }
    const box = el('div', 'gallery');
    const grid = el('div', 'gallery__grid');
    mediaGallery.forEach((g) => grid.appendChild(galleryItem(g)));
    box.appendChild(grid);
    scope.result.appendChild(box);
  }

  function galleryItem(g) {
    const card = el('div', 'gallery__item');
    if (g.type === 'video') {
      const v = el('video');
      v.controls = true;
      v.preload = 'metadata';
      v.playsInline = true;
      v.src = safeMediaUrl(g.url);
      card.appendChild(v);
    } else if (g.type === 'audio') {
      const row = el('div', 'gallery__audio');
      row.appendChild(el('span', 'gallery__audio-icon', '🎵'));
      const a = el('audio');
      a.controls = true;
      a.src = g.url; // audio may be a data: URI (recorded WAV) — intentionally allowed
      row.appendChild(a);
      card.appendChild(row);
    } else {
      const img = el('img');
      img.loading = 'lazy';
      img.alt = 'Media';
      renderImageViaBlob(img, g.url);
      card.appendChild(img);
      card.classList.add('gallery__item--img');
      card.title = 'Open full size';
      card.addEventListener('click', () => openImageInResult(g.url));
    }
    return card;
  }

  function openImageInResult(url) {
    toolResultEl.innerHTML = '';
    renderMedia(toolResultEl, url, 'image', { noGallery: true });
    if (ccMain) ccMain.scrollTop = 0;
  }

  // ---- Devices view (#5) ----------------------------------------------------
  function openDevices(scope) {
    const box = el('div', 'devices');
    scope.result.appendChild(box);
    renderDevices(box);
  }

  async function renderDevices(box) {
    box.innerHTML = '';
    box.appendChild(el('div', 'result-loading', 'Loading devices…'));
    let devices;
    try {
      devices = await fetchDevices();
    } catch (err) {
      box.innerHTML = '';
      box.appendChild(el('div', 'hint', '🔌 Backend unreachable — could not load devices.'));
      return;
    }
    box.innerHTML = '';
    if (!devices.length) {
      box.appendChild(el('div', 'hint', 'No phones registered yet.'));
      return;
    }
    const firstOnline = devices.find((d) => d.online);
    const firstOnlineId = firstOnline ? (firstOnline.device_id || firstOnline.id || '') : '';
    const layout = el('div', 'devices__grid');
    box.appendChild(layout);
    devices.forEach((d) => {
      const id = d.device_id || d.id || '';
      const card = el('div', 'device-card');
      // Highlight the currently-selected device (or the first online one by default).
      const isPrimary = id
        ? (selectedDeviceId ? id === selectedDeviceId : (d.online && id === firstOnlineId))
        : false;
      if (isPrimary) card.classList.add('device-card--primary');
      const head = el('div', 'device-card__head');
      head.appendChild(el('span', 'dot ' + (d.online ? 'dot--online' : 'dot--offline')));
      head.appendChild(el('span', 'device-card__name', friendlyDeviceName(d)));
      if (isPrimary) head.appendChild(el('span', 'device-card__primary-badge', '★ Primary'));
      const status = el('div', 'device-card__status', d.online ? 'Loading status…' : '⚪ Offline');
      card.appendChild(head);
      card.appendChild(status);
      if (d.online && id) {
        card.classList.add('device-card--clickable');
        card.title = 'Make primary';
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        const activate = () => { selectDevice(id); renderDevices(box); refreshStatusBar(); };
        card.addEventListener('click', activate);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
        });
      }
      layout.appendChild(card);
      // Only fetch status for ONLINE devices — an offline device never returns,
      // which parks commands in the relay queue and starves other commands.
      if (d.online) loadDeviceStatus(id, status);
    });
  }

  async function loadDeviceStatus(id, statusEl) {
    if (!id) { statusEl.textContent = '—'; return; }
    let battery = null, storage = null, network = null;
    try {
      [battery, storage, network] = await Promise.all([
        safeCommand('battery', id, { log: false }),
        safeCommand('storage', id, { log: false }),
        safeCommand('network', id, { log: false }),
      ]);
    } catch (err) { /* ignore */ }
    statusEl.innerHTML = '';
    statusEl.appendChild(el('span', 'device-card__stat', '🔋 ' + (battery ? summarizeBattery(battery) : '—')));
    statusEl.appendChild(el('span', 'device-card__stat', '💾 ' + (storage ? compact(storage, 18) : '—')));
    statusEl.appendChild(el('span', 'device-card__stat', '📶 ' + (network ? compact(network, 16) : '—')));
  }

  // ---- Sound + micro-animations support (#10) --------------------------------
  // Very short "tap" blip via the Web Audio API. No assets. Lazily initialized
  // on the first user gesture; fully skipped for reduced-motion / no audio.
  let audioCtx = null;
  let audioUnavailable = false;

  function ensureAudio() {
    if (prefersReducedMotion() || audioUnavailable) return null;
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { audioUnavailable = true; return null; }
      try { audioCtx = new AC(); } catch (err) { audioUnavailable = true; return null; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function playTap() {
    const ctx = ensureAudio();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(760, t);
    osc.frequency.exponentialRampToValueAtTime(430, t + 0.06);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.05, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  function initSound() {
    if (prefersReducedMotion()) return;
    document.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('button, .tile, summary, a.result-dl, a.result-maps, .msg__media-dl') : null;
      if (!t || t.disabled) return;
      playTap();
    }, true);
  }

  // ---- Phone 3D view (#9, Three.js loaded lazily) ----------------------------
  let threePromise = null;

  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (threePromise) return threePromise;
    threePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      // Self-hosted copy (pinned three@0.160.0) — removes the jsDelivr CDN
      // dependency so the 3D view no longer loads third-party code at runtime.
      s.src = './three.min.js';
      s.async = true;
      s.onload = () => resolve(window.THREE);
      s.onerror = () => { threePromise = null; reject(new Error('Three.js failed to load')); };
      document.head.appendChild(s);
    });
    return threePromise;
  }

  let phone3dSerial = 0;
  let phone3d = null; // active scene state (null when the view is closed)

  function setP3dError(statusEl, msg) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.add('p3d__status--error');
  }

  function openPhone3d(scope) {
    const wrap = el('div', 'p3d');
    const status = el('div', 'p3d__status', 'Loading 3D…');
    const canvas = el('canvas', 'p3d__canvas');
    wrap.appendChild(canvas);
    wrap.appendChild(status);
    scope.result.appendChild(wrap);
    startPhone3d(wrap, canvas, status);
  }

  function startPhone3d(container, canvas, statusEl) {
    const myId = ++phone3dSerial;

    let webgl = false;
    try {
      const t = document.createElement('canvas');
      webgl = !!(window.WebGLRenderingContext && (t.getContext('webgl') || t.getContext('experimental-webgl')));
    } catch (err) { webgl = false; }
    if (!webgl) { setP3dError(statusEl, '3D not supported'); return; }

    loadThree().then((THREE) => {
      if (phone3dSerial !== myId) return; // view was closed/reopened before load finished
      try {
        initPhone3d(THREE, container, canvas, statusEl);
      } catch (err) {
        setP3dError(statusEl, '3D not supported');
      }
    }).catch(() => {
      if (phone3dSerial === myId) setP3dError(statusEl, '3D not supported (could not load Three.js)');
    });
  }

  function initPhone3d(THREE, container, canvas, statusEl) {
    const state = {
      container, canvas, statusEl,
      renderer: null, scene: null, camera: null, phone: null, screenPlane: null,
      screenCanvas: null, screenCtx: null, screenTex: null,
      baseRotY: 0, dragRotY: 0, dragRotX: 0, hoverTiltY: 0, hoverTiltX: 0,
      dragging: false, lastX: 0, lastY: 0,
      raf: 0, timer: 0, w: 0, h: 0, handlers: null,
    };
    phone3d = state;

    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    state.renderer = renderer;

    const scene = new THREE.Scene();
    state.scene = scene;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0.2, 6.4);
    camera.lookAt(0, 0, 0);
    state.camera = camera;

    scene.add(new THREE.AmbientLight(0x9fb0cf, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(3, 5, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x5f83ff, 1.0);
    rim.position.set(-4, 2, -3);
    scene.add(rim);

    const phone = new THREE.Group();
    scene.add(phone);
    state.phone = phone;

    // Rounded-phone body from a rounded-rect extrusion (core THREE, no addon).
    const bodyW = 1.8, bodyH = 3.6, bodyR = 0.24, bodyD = 0.18, bevel = 0.035;
    const shape = new THREE.Shape();
    {
      const x = -bodyW / 2, y = -bodyH / 2, w = bodyW, h = bodyH, r = bodyR;
      shape.moveTo(x + r, y);
      shape.lineTo(x + w - r, y);
      shape.quadraticCurveTo(x + w, y, x + w, y + r);
      shape.lineTo(x + w, y + h - r);
      shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      shape.lineTo(x + r, y + h);
      shape.quadraticCurveTo(x, y + h, x, y + h - r);
      shape.lineTo(x, y + r);
      shape.quadraticCurveTo(x, y, x + r, y);
    }
    const bodyGeo = new THREE.ExtrudeGeometry(shape, {
      depth: bodyD, bevelEnabled: true, bevelThickness: bevel,
      bevelSize: bevel, bevelSegments: 3, curveSegments: 12,
    });
    bodyGeo.computeBoundingBox();
    const frontZ = (bodyGeo.boundingBox && bodyGeo.boundingBox.max) ? bodyGeo.boundingBox.max.z : (bodyD / 2 + bevel);
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0x2a3346, metalness: 0.65, roughness: 0.4 }));
    phone.add(body);

    // Live screen: a 2D canvas texture showing device name + battery %.
    const screenCanvas = document.createElement('canvas');
    screenCanvas.width = 256;
    screenCanvas.height = 512;
    state.screenCanvas = screenCanvas;
    state.screenCtx = screenCanvas.getContext('2d');
    const screenTex = new THREE.CanvasTexture(screenCanvas);
    screenTex.minFilter = THREE.LinearFilter;
    screenTex.magFilter = THREE.LinearFilter;
    state.screenTex = screenTex;

    // Dark bezel + glowing screen plane.
    const bezel = new THREE.Mesh(
      new THREE.PlaneGeometry(bodyW * 0.92, bodyH * 0.96),
      new THREE.MeshBasicMaterial({ color: 0x070a12 })
    );
    bezel.position.z = frontZ + 0.006;
    phone.add(bezel);

    const screenPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(bodyW * 0.84, bodyH * 0.88),
      new THREE.MeshBasicMaterial({ map: screenTex })
    );
    screenPlane.position.z = frontZ + 0.012;
    phone.add(screenPlane);
    state.screenPlane = screenPlane;

    drawScreenTexture(state, '—', '—');

    // Manual pointer control: hover tilt + drag to rotate (no OrbitControls).
    const down = (e) => {
      state.dragging = true;
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    };
    const move = (e) => {
      const r = canvas.getBoundingClientRect();
      if (r.width && r.height) {
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        state.hoverTiltY = px * 0.55;
        state.hoverTiltX = -py * 0.4;
      }
      if (state.dragging) {
        const dx = e.clientX - state.lastX;
        const dy = e.clientY - state.lastY;
        state.lastX = e.clientX;
        state.lastY = e.clientY;
        state.dragRotY += dx * 0.011;
        state.dragRotX += dy * 0.011;
        state.dragRotX = Math.max(-1.15, Math.min(1.15, state.dragRotX));
      }
    };
    const up = () => { state.dragging = false; };
    state.handlers = { down, move, up };
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    statusEl.textContent = 'Drag / move to tilt · refreshes every 5s';
    statusEl.classList.remove('p3d__status--error');

    function resizeIfNeeded() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      if (w !== state.w || h !== state.h) {
        state.w = w;
        state.h = h;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
    }

    function animate() {
      state.raf = requestAnimationFrame(animate);
      if (phone3d !== state) return; // disposed
      resizeIfNeeded();
      if (!state.dragging) state.baseRotY += 0.0042;
      const ty = state.baseRotY + state.dragRotY + state.hoverTiltY;
      const tx = state.dragRotX + state.hoverTiltX;
      phone.rotation.y += (ty - phone.rotation.y) * 0.14;
      phone.rotation.x += (tx - phone.rotation.x) * 0.14;
      renderer.render(scene, camera);
    }
    animate();

    // Live screen text: battery + deviceinfo, refreshed at most every ~5s.
    const refresh = async () => {
      if (phone3d !== state) return;
      const id = await resolveOnlineTargetId();
      if (phone3d !== state) return;
      if (!id) {
        drawScreenTexture(state, '—', '—');
        return;
      }
      const [battery, info] = await Promise.all([
        safeCommand('battery', id, { log: false }),
        safeCommand('deviceinfo', id, { log: false }),
      ]);
      if (phone3d !== state) return;
      let name = '';
      const dev = devicesCache.find((d) => ((d.device_id || d.id) === id) && d.online);
      if (dev) name = friendlyDeviceName(dev);
      if (!name && info) name = compact(info, 22);
      drawScreenTexture(state, name || '—', battery ? summarizeBattery(battery) : '—');
    };
    refresh();
    // 15s (not 5s) — a 5s battery+deviceinfo poll floods the free relay while
    // this view is open and adds to the command backlog.
    state.timer = setInterval(refresh, 15000);
  }

  function drawScreenTexture(state, name, batt) {
    const ctx = state.screenCtx;
    if (!ctx) return;
    const W = state.screenCanvas.width, H = state.screenCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#0f1c33');
    grad.addColorStop(1, '#080d1a');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1a2740';
    ctx.beginPath();
    ctx.arc(W / 2, 24, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#7aa5ff';
    ctx.font = '600 26px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let label = String(name || '—');
    if (label.length > 14) label = label.slice(0, 13) + '…';
    ctx.fillText(label, W / 2, 96);
    ctx.fillStyle = '#eaf0fb';
    ctx.font = '800 56px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(String(batt || '—'), W / 2, 190);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 22px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText('BATTERY', W / 2, 244);
    ctx.fillStyle = '#5a6b8c';
    ctx.font = '26px system-ui, sans-serif';
    ctx.fillText('📱', W / 2, 316);
    if (state.screenTex) state.screenTex.needsUpdate = true;
  }

  function disposePhone3d() {
    phone3dSerial++; // invalidate any in-flight Three.js load
    const s = phone3d;
    phone3d = null;
    if (!s) return;
    if (s.raf) cancelAnimationFrame(s.raf);
    s.raf = 0;
    if (s.timer) clearInterval(s.timer);
    s.timer = 0;
    if (s.canvas && s.handlers) {
      s.canvas.removeEventListener('pointerdown', s.handlers.down);
      s.canvas.removeEventListener('pointermove', s.handlers.move);
      s.canvas.removeEventListener('pointerup', s.handlers.up);
      s.canvas.removeEventListener('pointercancel', s.handlers.up);
    }
    if (s.scene) {
      s.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
    }
    if (s.screenTex) s.screenTex.dispose();
    s.screenTex = null;
    if (s.renderer) s.renderer.dispose();
    s.renderer = null;
  }

  // ---------------------------------------------------------------------------
  // Live Camera / Live Audio (WebRTC peer-to-peer).
  // The relay (gokul-agent-server.onrender.com) only forwards SDP/ICE over
  // wss://<relay>/signal?room=<device_id>&role=browser. The actual video/audio
  // flows phone <-> browser over the STUN/ICE-negotiated peer route, so the free
  // Render relay is never in the media path.
  // ---------------------------------------------------------------------------
  const SIGNAL_WS_BASE = 'wss://gokul-agent-server.onrender.com/signal';
  // Relay auth for the /signal WebSocket (matches the relay API key).
  const SIGNAL_KEY = '&key=' + encodeURIComponent('Y7I13VPjo7X32XzektRatuYXD6ROvvwdvJdeT3Gf8roX');
  const LIVE_STUN = 'stun:stun.l.google.com:19302';
  // Public TURN relay (openrelay.metered.ca) so peers behind symmetric NAT can
  // still connect when a direct host/STUN candidate can't be negotiated.
  const LIVE_TURN = {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  };

  // Active session: { ws, pc, video, timer, negTimer, gotOffer, deviceId, mode } or null.
  let liveStream = null;
  // Start-lock so a double-tap on Start can't orphan a half-open WebRTC session.
  let liveBusy = false;

  function liveCleanup() {
    const s = liveStream;
    liveStream = null;
    if (!s) return;
    try { if (s.negTimer) clearTimeout(s.negTimer); } catch (err) { /* ignore */ }
    try { if (s.timer) clearInterval(s.timer); } catch (err) { /* ignore */ }
    try { if (s.ws) { s.ws.send(JSON.stringify({ type: 'stop' })); s.ws.close(1000, 'stop'); } } catch (err) { /* ignore */ }
    try { if (s.pc) s.pc.close(); } catch (err) { /* ignore */ }
    try { if (s.video) s.video.srcObject = null; } catch (err) { /* ignore */ }
    // Also tell the relay (command channel) to stop the phone-side live source.
    try {
      const stopCmd = s.mode === 'audio' ? 'live_audio stop' : 'live_camera stop';
      safeCommand(stopCmd, s.deviceId, { log: false });
    } catch (err) { /* ignore */ }
  }

  // Wire a remote MediaStream into the <video>, honoring the autoplay policy:
  // keep audio muted until playback actually starts, then unmute; if playback is
  // blocked, surface a "tap to unmute" affordance instead of claiming streaming.
  function setLiveStreamPlaying(video, remoteStream, status, isVideo, s) {
    if (video.srcObject !== remoteStream) video.srcObject = remoteStream;
    const attempt = video.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.then(() => {
        if (liveStream !== s) return;
        // audio mode: unmute immediately (play succeeded). video mode: keep muted
        // for autoplay but wire tap-to-unmute so the mic is audible on demand.
        if (!isVideo) { try { video.muted = false; } catch (err) { /* ignore */ } }
        if (isVideo) {
          status.textContent = '🎥 video live · 🔇 tap here to hear mic';
          enableTapToUnmute(video, status, '🎥 video + mic live…');
        } else {
          status.textContent = '🎙️ Streaming live audio…';
        }
      }).catch(() => {
        if (liveStream !== s) return;
        // autoplay blocked — offer tap-to-unmute in BOTH modes.
        if (isVideo) {
          status.textContent = '🎥 video · 🔇 tap to unmute + hear mic';
          enableTapToUnmute(video, status, '🎥 video + mic live…');
        } else {
          status.textContent = '🔇 Tap to unmute';
          enableTapToUnmute(video, status, '🎙️ Streaming live audio…');
        }
      });
    } else {
      if (isVideo) {
        status.textContent = '🎥 video live · 🔇 tap here to hear mic';
        enableTapToUnmute(video, status, '🎥 video + mic live…');
      } else {
        status.textContent = '🎙️ Streaming live audio…';
      }
    }
  }

  function enableTapToUnmute(video, status, doneText) {
    if (!status || status._unmuteTap) return;
    status._unmuteTap = true;
    status.style.cursor = 'pointer';
    status.title = 'Tap to unmute mic';
    status.addEventListener('click', () => {
      try {
        video.muted = false;
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
        status.textContent = doneText || '🎙️ Streaming live audio…';
        status.style.cursor = '';
        status.title = '';
      } catch (err) { /* ignore */ }
    });
  }

  // Build the Live Camera / Live Audio tile view.
  function openLiveStream(scope, mode) {
    const isVideo = mode === 'camera';
    const box = el('div', 'live');

    const status = el('div', 'hint', 'Ready — Start to stream live.');

    // Lens selector (camera only) — pick front/back before streaming.
    let lens = 'back';
    if (isVideo) {
      let lensBack = null, lensFront = null;
      const setLens = (l) => {
        lens = l;
        if (lensBack) lensBack.classList.toggle('tc-btn--active', l === 'back');
        if (lensFront) lensFront.classList.toggle('tc-btn--active', l === 'front');
      };
      lensBack = makeButton('🔘 Back', () => setLens('back'), 'tc-btn tc-btn--active');
      lensFront = makeButton('🔘 Front', () => setLens('front'), 'tc-btn');
      const lensRow = el('div', 'seg');
      lensRow.appendChild(lensBack);
      lensRow.appendChild(lensFront);
      box.appendChild(lensRow);
    }

    const startBtn = makeButton(isVideo ? '▶ Start camera' : '▶ Start mic',
      () => startLive(mode, video, status, startBtn, lens), 'tc-btn tc-btn--primary');
    const stopBtn = makeButton('⏹ Stop', () => {
      liveCleanup();
      status.textContent = 'Stopped.';
    }, 'tc-btn tc-btn--danger');
    const btnRow = el('div', 'seg');
    btnRow.appendChild(startBtn);
    btnRow.appendChild(stopBtn);

    const video = el('video', 'live__video');
    video.muted = true;            // start muted to pass autoplay; unmute on play success
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    if (!isVideo) video.style.display = 'none'; // audio-only: hidden player

    const mediaWrap = el('div', 'result-media');
    mediaWrap.appendChild(video);

    box.appendChild(btnRow);
    box.appendChild(status);
    box.appendChild(mediaWrap);
    scope.result.appendChild(box);
  }

  async function startLive(mode, video, status, startBtn, lens) {
    if (liveBusy) return;
    liveBusy = true;
    if (startBtn) startBtn.disabled = true;
    try {
      const isVideo = mode === 'camera';

      if (!window.RTCPeerConnection) {
        status.textContent = '⚠️ This browser does not support live streaming (RTCPeerConnection missing).';
        return;
      }

      liveCleanup(); // drop any prior session

      // Resolve the target phone (selected device, else first online device).
      let devices = devicesCache;
      if (!devices || !devices.length) {
        try { devices = await fetchDevices(); populateDeviceSelect(devices); } catch (err) { devices = devicesCache || []; }
      }
      const id = selectedDeviceId ||
        ((devices || []).find((d) => d.online) || {}).device_id ||
        ((devices || [])[0] || {}).device_id || '';
      if (!id) {
        status.textContent = 'No phone registered — wait for a phone to come online, then Start again.';
        return;
      }

      // Tell the phone to start its WebRTC source (fire-and-forget). The phone
      // then joins the /signal room and sends us the offer we answer below.
      const startCmd = isVideo ? ('live_camera start ' + (lens || 'back')) : 'live_audio start';
      postCommand(startCmd, id, { log: false }).catch(() => {});

      const pc = new RTCPeerConnection({ iceServers: [{ urls: LIVE_STUN }, LIVE_TURN] });
      const remoteStream = new MediaStream();
      const s = { ws: null, pc, video, timer: null, negTimer: null, gotOffer: false, deviceId: id, mode: isVideo ? 'camera' : 'audio' };
      liveStream = s;

      pc.ontrack = (ev) => {
        remoteStream.addTrack(ev.track);
        setLiveStreamPlaying(video, remoteStream, status, isVideo, s);
      };
      // Safari (< 16) exposes incoming streams via `addstream` instead of `track`.
      pc.onaddstream = (ev) => {
        if (ev && ev.stream) {
          ev.stream.getTracks().forEach((t) => { try { remoteStream.addTrack(t); } catch (err) { /* ignore */ } });
        }
        setLiveStreamPlaying(video, remoteStream, status, isVideo, s);
      };

      pc.oniceconnectionstatechange = () => {
        if (liveStream !== s) return;
        const st = pc.iceConnectionState;
        if (st === 'failed' || st === 'disconnected') {
          status.textContent = '⚠️ Connection ' + st + ' — streaming stopped.';
          liveCleanup();
        } else if (st === 'connected' || st === 'completed') {
          if (s.negTimer) { clearTimeout(s.negTimer); s.negTimer = null; }
        }
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !s.ws) return;
        try {
          s.ws.send(JSON.stringify({
            type: 'ice',
            candidate: {
              candidate: ev.candidate.candidate,
              sdpMid: ev.candidate.sdpMid,
              sdpMLineIndex: ev.candidate.sdpMLineIndex,
            },
          }));
        } catch (err) { /* ignore */ }
      };

      // Give negotiation up to ~20s to complete, then tear down and stop the relay.
      s.negTimer = setTimeout(() => {
        if (liveStream !== s) return;
        if (s.gotOffer && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) return;
        status.textContent = '⚠️ Negotiation timed out (20s) — check the phone and retry.';
        liveCleanup();
      }, 20000);

      const wsUrl = SIGNAL_WS_BASE + '?room=' + encodeURIComponent(id) + '&role=browser' + SIGNAL_KEY;
      status.textContent = 'Connecting to ' + id + '…';

      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        status.textContent = '⚠️ WebSocket not supported / blocked.';
        liveCleanup();
        return;
      }
      s.ws = ws;

      ws.onopen = () => {
        // Announce ourselves; re-request the offer until the phone replies (the
        // phone may have finished its setup before we joined the room).
        const ping = () => {
          if (s.gotOffer || liveStream !== s) return;
          try { ws.send(JSON.stringify({ type: 'start' })); } catch (err) { /* ignore */ }
        };
        ping();
        s.timer = setInterval(ping, 2500);
      };

      ws.onmessage = async (evt) => {
        let m;
        try { m = JSON.parse(evt.data); } catch (err) { return; }
        const type = m && m.type;
        if (type === 'offer' && m.sdp && m.sdp.sdp) {
          if (s.gotOffer) return; // answer only once
          s.gotOffer = true;
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'answer', sdp: { type: 'answer', sdp: answer.sdp } }));
            status.textContent = 'Negotiating… sending answer';
          } catch (err) {
            status.textContent = '⚠️ Negotiation failed: ' + (err && err.message ? err.message : err);
          }
        } else if (type === 'ice' && m.candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate({
              candidate: m.candidate.candidate,
              sdpMid: m.candidate.sdpMid,
              sdpMLineIndex: m.candidate.sdpMLineIndex,
            }));
          } catch (err) { /* ignore */ }
        }
      };

      ws.onerror = () => { status.textContent = '⚠️ Signaling unavailable (relay unreachable).'; };
      ws.onclose = () => { if (liveStream === s) status.textContent = 'Signaling closed — press Stop, then Back.'; };
    } finally {
      liveBusy = false;
      if (startBtn) startBtn.disabled = false;
    }
  }

  // ---- Live location MAP view (#12) -----------------------------------------
  // Renders an OpenStreetMap iframe embed (no API key) centered on the latest
  // GPS fix, plus a text list of recent lat,lng,ts below.
  function osmEmbedUrl(lat, lng) {
    const pad = 0.006;
    const minLon = lng - pad, minLat = lat - pad * 0.75;
    const maxLon = lng + pad, maxLat = lat + pad * 0.75;
    return 'https://www.openstreetmap.org/export/embed.html?bbox=' +
      minLon.toFixed(6) + '%2C' + minLat.toFixed(6) + '%2C' +
      maxLon.toFixed(6) + '%2C' + maxLat.toFixed(6) +
      '&layer=mapnik&marker=' + lat.toFixed(6) + '%2C' + lng.toFixed(6);
  }

  // Defensively decode whatever shape the relay returns into {lat,lng,ts} points.
  function parseLocationPoints(data) {
    const items = [];
    const push = (p) => {
      if (!p || typeof p !== 'object') return;
      const lat = parseFloat(p.lat ?? p.latitude ?? p.y);
      const lng = parseFloat(p.lng ?? p.lon ?? p.longitude ?? p.long ?? p.x);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const ts = p.ts ?? p.time ?? p.timestamp ?? p.created_at ?? p.date ?? '';
      items.push({ lat, lng, ts });
    };
    if (Array.isArray(data)) data.forEach(push);
    else if (data && typeof data === 'object') {
      ['points', 'history', 'locations', 'items', 'entries'].forEach((k) => {
        if (Array.isArray(data[k])) data[k].forEach(push);
      });
      push(data); // in case it's a single point object
    }
    return items;
  }

  async function openMap(scope) {
    const box = el('div', 'map-view');
    scope.result.appendChild(box);

    let deviceId = selectedDeviceId || '';
    if (!deviceId) {
      try { deviceId = await resolveOnlineTargetId(); } catch (err) { deviceId = ''; }
    }

    box.appendChild(el('div', 'result-loading', 'Loading location history…'));

    const qs = new URLSearchParams({ limit: '50' });
    if (deviceId) qs.set('device_id', deviceId);

    let points = [];
    let unavailable = false;
    try {
      const res = await fetch(BACKEND_LOCATION_URL + '?' + qs.toString(), {
        headers: { 'X-Web-Key': agentWebKey() },
      });
      if (res.status === 404) {
        unavailable = true; // endpoint not wired on the relay yet
      } else if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      } else {
        const data = await res.json().catch(() => null);
        points = parseLocationPoints(data);
      }
    } catch (err) {
      box.innerHTML = '';
      box.appendChild(el('div', 'hint', '🔌 Could not load location history — the relay did not respond.'));
      return;
    }

    box.innerHTML = '';
    if (unavailable) {
      box.appendChild(el('div', 'hint', '📍 Location history is not available yet (the relay does not expose /location_history).'));
      box.appendChild(el('div', 'hint', 'Use the 📍 Location tool to fetch the current GPS position.'));
      return;
    }
    if (!points.length) {
      box.appendChild(el('div', 'hint', 'No location history yet — the phone has not reported any GPS fixes.'));
      return;
    }

    const latest = points[0];
    const iframe = el('iframe', 'map-view__frame');
    iframe.src = osmEmbedUrl(latest.lat, latest.lng);
    iframe.loading = 'lazy';
    iframe.title = 'Device location map';
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    box.appendChild(iframe);

    box.appendChild(el('div', 'tool-controls__label', 'Recent locations'));
    const list = el('div', 'map-view__list');
    points.forEach((p) => {
      const row = el('div', 'map-view__row');
      row.appendChild(el('span', 'map-view__coords', p.lat.toFixed(5) + ', ' + p.lng.toFixed(5)));
      if (p.ts) row.appendChild(el('span', 'map-view__ts', new Date(p.ts).toLocaleString()));
      list.appendChild(row);
    });
    box.appendChild(list);
  }

  // ---- Automation scheduler view (#13: ⏰ Tasks) -----------------------------
  function parseScheduleList(data) {
    let arr = null;
    if (Array.isArray(data)) arr = data;
    else if (data && typeof data === 'object') {
      ['tasks', 'schedules', 'schedule', 'items'].forEach((k) => {
        if (Array.isArray(data[k])) { arr = data[k]; return; }
      });
    }
    return (arr || [])
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        id: t.id ?? t.task_id ?? t._id ?? t.name ?? '',
        command: t.command ?? t.cmd ?? '',
        interval_seconds: t.interval_seconds ?? t.interval ?? t.every ?? '',
        device_id: t.device_id ?? t.device ?? '',
      }));
  }

  async function populateTaskDevices(sel) {
    let devices = devicesCache;
    if (!devices || !devices.length) {
      try { devices = await fetchDevices(); populateDeviceSelect(devices); } catch (err) { devices = []; }
    }
    sel.innerHTML = '';
    sel.appendChild(new Option('📱 Auto device', ''));
    (devices || []).forEach((d) => {
      const v = d.device_id || d.id || '';
      if (v) sel.appendChild(new Option(friendlyDeviceName(d), v));
    });
  }

  async function refreshTasks(listEl) {
    listEl.innerHTML = '';
    listEl.appendChild(el('div', 'result-loading', 'Loading tasks…'));
    let tasks = [];
    try {
      const res = await fetch(BACKEND_SCHEDULE_URL, { headers: { 'X-Web-Key': agentWebKey() } });
      if (res.status === 404) {
        listEl.innerHTML = '';
        listEl.appendChild(el('div', 'hint', '⏰ Task scheduling is not available yet (the relay does not expose /schedule).'));
        return;
      }
      const data = await res.json().catch(() => null);
      tasks = parseScheduleList(data);
    } catch (err) {
      listEl.innerHTML = '';
      listEl.appendChild(el('div', 'hint', '🔌 Could not load tasks — the relay did not respond.'));
      return;
    }
    listEl.innerHTML = '';
    if (!tasks.length) {
      listEl.appendChild(el('div', 'hint', 'No scheduled tasks yet.'));
      return;
    }
    tasks.forEach((t) => listEl.appendChild(taskRow(t, listEl)));
  }

  function taskRow(t, listEl) {
    const row = el('div', 'tasks__row');
    const head = el('div', 'tasks__row-head');
    head.appendChild(el('span', 'tasks__cmd', t.command || '(no command)'));
    const del = makeButton('🗑 Delete', () => deleteTask(t.id, listEl), 'tc-btn tasks__del');
    head.appendChild(del);
    row.appendChild(head);
    const meta = [];
    if (t.interval_seconds != null && t.interval_seconds !== '') meta.push('every ' + t.interval_seconds + 's');
    if (t.device_id) meta.push('device ' + t.device_id);
    if (meta.length) row.appendChild(el('div', 'tasks__meta', meta.join(' · ')));
    return row;
  }

  async function deleteTask(id, listEl) {
    if (id == null || id === '') {
      toast('⚠️ This task has no id — the relay did not return one, so it cannot be deleted from here.');
      return;
    }
    try {
      const res = await fetch(BACKEND_SCHEDULE_URL, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Web-Key': agentWebKey() },
        body: JSON.stringify({ id: String(id) }),
      });
      if (res.status === 404) { toast('⏰ Task deletion is not available yet.'); return; }
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error((d && (d.error || d.message)) || ('HTTP ' + res.status));
      }
      toast('🗑 Task deleted');
      refreshTasks(listEl);
    } catch (err) {
      toast('⚠️ ' + (err.message || 'Could not delete task'));
    }
  }

  async function addTask(deviceSel, cmdInput, intervalInput, listEl) {
    const command = cmdInput.value.trim();
    const interval = parseInt(intervalInput.value, 10);
    if (!command) { toast('Enter a command to schedule'); return; }
    if (!Number.isFinite(interval) || interval < 1) { toast('Interval must be a positive number of seconds'); return; }
    const device_id = deviceSel.value || '';
    try {
      const res = await fetch(BACKEND_SCHEDULE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Web-Key': agentWebKey() },
        body: JSON.stringify({ device_id, command, interval_seconds: interval }),
      });
      if (res.status === 404) { toast('⏰ Scheduling is not available yet.'); return; }
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      cmdInput.value = '';
      intervalInput.value = '60';
      toast('✅ Task scheduled');
      refreshTasks(listEl);
    } catch (err) {
      toast('⚠️ ' + (err.message || 'Could not schedule task'));
    }
  }

  function openTasks(scope) {
    const box = el('div', 'tasks');
    scope.result.appendChild(box);
    box.appendChild(el('div', 'hint', '⏰ Tasks run on the relay and are memory-only — they reset if the relay restarts.'));

    const formBox = el('div', 'tasks__form');
    formBox.appendChild(el('div', 'tool-controls__label', 'Add a scheduled task'));
    const deviceSel = el('select', 'tasks__device');
    formBox.appendChild(makeField('Device', deviceSel));
    const cmdInput = makeInput('text', 'Command (e.g. battery, camera_link back)', '');
    formBox.appendChild(makeField('Command', cmdInput));
    const intervalInput = makeInput('number', 'Interval in seconds', 60);
    formBox.appendChild(makeField('Interval (s)', intervalInput));
    formBox.appendChild(makeButton('＋ Add task', () => addTask(deviceSel, cmdInput, intervalInput, listEl), 'tc-btn tc-btn--primary'));
    box.appendChild(formBox);

    const listEl = el('div', 'tasks__list');
    box.appendChild(listEl);

    populateTaskDevices(deviceSel);
    refreshTasks(listEl);
  }

  // ---- Real-time notifications (#14: 🔴 Live Notifs) -------------------------
  // EventSource cannot set the X-Web-Key / custom headers, so we consume the SSE
  // stream with fetch() + a ReadableStream reader and append `data:` lines.
  const notifBtn = $('#notifBtn');
  const notifBadge = $('#notifBadge');
  let notifCount = 0;
  const recentNotifs = [];
  let notifStreamActive = false;
  let notifReconnectTimer = null;

  function updateNotifBadge() {
    if (!notifBadge) return;
    if (notifCount > 0) {
      notifBadge.hidden = false;
      notifBadge.textContent = notifCount > 99 ? '99+' : String(notifCount);
    } else {
      notifBadge.hidden = true;
    }
  }

  function setNotifState(state) {
    if (!notifBtn) return;
    notifBtn.classList.toggle('notif-btn--offline', state === 'offline');
    notifBtn.title = state === 'offline' ? '🔴 Notifications offline' : '🔴 Live notifications';
  }

  function handleNotifData(data) {
    let obj = null;
    try { obj = JSON.parse(data); } catch (err) { obj = null; }
    let text = '';
    if (obj && typeof obj === 'object') {
      const raw = obj.text ?? obj.message ?? obj.notification ?? obj.alert ?? obj.title ?? obj.body ?? obj.data;
      if (typeof raw === 'string') text = raw;
      else if (raw && typeof raw === 'object') {
        const t = raw.text ?? raw.message ?? raw.title ?? raw.body ?? '';
        if (typeof t === 'string') text = t;
      }
    } else {
      text = String(data || '').trim();
    }
    if (!text) return;
    notifCount++;
    recentNotifs.push({ ts: Date.now(), text });
    if (recentNotifs.length > 8) recentNotifs.shift();
    updateNotifBadge();
    toast('🔔 ' + text);
  }

  function scheduleNotifReconnect() {
    if (notifReconnectTimer) return;
    notifReconnectTimer = setTimeout(() => {
      notifReconnectTimer = null;
      if (document.visibilityState === 'visible') connectNotifStream();
      else scheduleNotifReconnect();
    }, 10000);
  }

  async function connectNotifStream() {
    if (notifStreamActive) return;
    notifStreamActive = true;

    const qs = new URLSearchParams();
    if (selectedDeviceId) qs.set('device_id', selectedDeviceId);
    const url = BACKEND_NOTIF_URL + (qs.toString() ? '?' + qs.toString() : '');

    let res;
    try {
      res = await fetch(url, {
        headers: { 'X-Web-Key': agentWebKey(), 'Accept': 'text/event-stream' },
        cache: 'no-store',
      });
    } catch (err) {
      notifStreamActive = false;
      setNotifState('offline');
      scheduleNotifReconnect();
      return;
    }

    if (!res.ok || !res.body || typeof res.body.getReader !== 'function') {
      notifStreamActive = false;
      setNotifState('offline');
      scheduleNotifReconnect();
      return;
    }

    setNotifState('online');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (line.slice(0, 5) === 'data:') {
            const payload = line.slice(5).replace(/^\s+/, '');
            if (payload) handleNotifData(payload);
          }
        }
      }
    } catch (err) {
      /* stream interrupted — reconnect below */
    } finally {
      try { reader.cancel(); } catch (err) { /* ignore */ }
      notifStreamActive = false;
      setNotifState('offline');
      scheduleNotifReconnect();
    }
  }

  function initNotifStream() {
    if (typeof fetch !== 'function' || !window.ReadableStream || !window.TextDecoder) {
      setNotifState('offline');
      return;
    }
    connectNotifStream();
  }

  if (notifBtn) {
    notifBtn.addEventListener('click', () => {
      if (!notifCount) { toast('🔴 No new notifications'); return; }
      const preview = recentNotifs.slice(-3).map((n) => n.text).join('  ·  ');
      toast('🔴 ' + preview);
      notifCount = 0;
      updateNotifBadge();
    });
  }

  // Select a device as the primary target (used by the Devices admin grid).
  function selectDevice(id) {
    selectedDeviceId = id || '';
    if (selectedDeviceId) trySetItem('aiAgent.deviceId', selectedDeviceId);
    else tryRemoveItem('aiAgent.deviceId');
    if (deviceSelect) deviceSelect.value = selectedDeviceId;
    updateStatusDevice();
  }

  // The additional tiles (History / Gallery / Devices / Phone 3D / Live).
  const SPECIALS = [
    { id: 'history', emoji: '🕘', label: 'History', sub: 'Recent commands', color: '#8b5cf6', build: openHistory },
    { id: 'gallery', emoji: '🖼️', label: 'Gallery', sub: 'Captured media', color: '#f2b13c', build: openGallery },
    { id: 'devices', emoji: '📱', label: 'Devices', sub: 'All phones · status', color: '#3fb96a', build: openDevices },
    { id: 'map', emoji: '📍', label: 'Map', sub: 'Live GPS history', color: '#3fb96a', build: openMap },
    { id: 'tasks', emoji: '⏰', label: 'Tasks', sub: 'Scheduled commands', color: '#f2b13c', build: openTasks },
    { id: 'phone3d', emoji: '🛰️', label: 'Phone 3D', sub: 'Live phone model', color: '#38b2ac', onClose: disposePhone3d, build: openPhone3d },
    { id: 'livecamera', emoji: '🎥', label: 'Live Camera', sub: 'WebRTC video + mic', color: '#ff6b6b', onClose: liveCleanup, build: (s) => openLiveStream(s, 'camera') },
    { id: 'liveaudio', emoji: '🎙️', label: 'Live Audio', sub: 'WebRTC mic streaming', color: '#38b2ac', onClose: liveCleanup, build: (s) => openLiveStream(s, 'audio') },
  ];

  // ---------------------------------------------------------------------------
  // Multi-tab poll coordination (best-effort). Only one visible tab runs the
  // periodic device/status polls so several open tabs don't each hammer the free
  // relay. Tabs heartbeat over a BroadcastChannel; the lexicographically smallest
  // live tab id becomes the poll leader.
  // ---------------------------------------------------------------------------
  const POLL_BC_NAME = 'aiAgent.poll';
  let pollBC = null;
  let pollTabId = '';
  const pollSeen = {};
  let pollIsLeader = !('BroadcastChannel' in window);

  function initPollCoordinator() {
    if (!('BroadcastChannel' in window)) { pollIsLeader = true; return; }
    pollTabId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    pollSeen[pollTabId] = Date.now();
    try {
      pollBC = new BroadcastChannel(POLL_BC_NAME);
      pollBC.onmessage = (e) => {
        const d = e && e.data;
        if (d && d.id) pollSeen[d.id] = Date.now();
      };
      setInterval(() => {
        if (!pollBC) return;
        const now = Date.now();
        Object.keys(pollSeen).forEach((k) => { if (now - pollSeen[k] > 15000) delete pollSeen[k]; });
        pollSeen[pollTabId] = now;
        try { pollBC.postMessage({ id: pollTabId }); } catch (err) { /* ignore */ }
        const ids = Object.keys(pollSeen).sort();
        pollIsLeader = (ids[0] === pollTabId);
      }, 3000);
    } catch (err) {
      pollIsLeader = true; // BroadcastChannel blocked — this tab polls.
    }
  }

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
    if (themeColorMeta) themeColorMeta.setAttribute('content', isLight ? '#f4f6fa' : '#070a12');
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
  // Security-key gate (lock screen, verified against the backend)
  // ---------------------------------------------------------------------------
  const GATE_KEY = 'aiAgent.unlocked';
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
    void gateCard.offsetWidth;
    gateCard.classList.add('gate__card--shake');
  }

  function failGate(message) {
    if (gateError) {
      if (message) gateError.textContent = message;
      gateError.classList.add('is-visible');
    }
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

    // Guard against a double-submit while the backend key check is in flight.
    let gateChecking = false;

    gateForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (gateChecking) return;
      const key = gatePassword && gatePassword.value ? gatePassword.value.trim() : '';
      if (gateError) gateError.classList.remove('is-visible');
      gateChecking = true;
      try {
        // Persist the entered security key (it drives the X-Web-Key header), then
        // verify it against the backend. There is NO client-side comparison or
        // hardcoded key: the app unlocks only when the backend accepts the key.
        try { localStorage.setItem('agentWebKey', key); } catch { /* ignore */ }

        let res;
        try {
          res = await fetch(BACKEND_DEVICES_URL, { headers: { 'X-Web-Key': key } });
        } catch (err) {
          // Backend unreachable — cannot verify the key, so do not unlock.
          failGate('⚠️ Backend unreachable — could not verify your key.');
          return;
        }

        if (res.status === 401 || res.status === 403) {
          // Backend rejected the key — stay locked and don't linger a bad key.
          try { localStorage.removeItem('agentWebKey'); } catch { /* ignore */ }
          failGate('❌ Invalid security key — the backend rejected it.');
          return;
        }
        if (!res.ok) {
          failGate('⚠️ Backend error (HTTP ' + res.status + ')');
          return;
        }

        if (!res.ok) {
          failGate('⚠️ Backend error (HTTP ' + res.status + ')');
          return;
        }

        // Backend recognized the key (or is permissive when AGENT_WEB_KEY is
        // unset) — unlock for this session only.
        try { sessionStorage.setItem(GATE_KEY, '1'); } catch { /* ignore */ }
        hideGate();
      } finally {
        gateChecking = false;
      }
    });

    if (gatePassword) {
      gatePassword.addEventListener('input', () => {
        if (gateError) gateError.classList.remove('is-visible');
      });
    }
  }

  // Lock / Logout affordance in the settings footer.
  const lockApp = $('#lockApp');
  if (lockApp) {
    lockApp.addEventListener('click', () => {
      try { sessionStorage.removeItem(GATE_KEY); } catch { /* ignore */ }
      location.reload();
    });
  }

  // ---------------------------------------------------------------------------
  // Chat panel open/close
  // ---------------------------------------------------------------------------

  function isMobile() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 760px)').matches);
  }

  function setChatOpen(open) {
    chatPanel.classList.toggle('chat-panel--open', open);
    chatScrim.classList.toggle('is-visible', open && isMobile());
    if (open) {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
      setTimeout(() => input.focus(), 320);
    }
  }

  if (chatToggle) chatToggle.addEventListener('click', () => {
    setChatOpen(!chatPanel.classList.contains('chat-panel--open'));
  });
  if (closeChat) closeChat.addEventListener('click', () => setChatOpen(false));
  if (chatScrim) chatScrim.addEventListener('click', () => setChatOpen(false));

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  initGate();
  initTheme();
  renderProviderSelect();
  renderMessages();
  initVoiceInput();

  renderGrid();
  initParticles();
  initSound();

  refreshMcpStatus();
  renderMcpTools();
  initPollCoordinator(); // elect a single poll leader across open tabs
  initNotifStream(); // non-blocking SSE consumer for live phone notifications
  // Poll device status every 2 min (was 15s — was flooding the free relay).
  setInterval(() => { if (pollIsLeader) refreshMcpStatus(); }, 120000);

  // Status bar reads (battery/storage/network) — initial + every 5 min.
  // (Was 30s: 3 commands per poll was flooding the relay with a huge backlog,
  //  which starved media commands like camera/audio and caused timeouts.)
  refreshStatusBar();
  setInterval(() => { if (pollIsLeader) refreshStatusBar(); }, 300000);
})();
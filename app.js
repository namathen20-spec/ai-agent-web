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
  };

  const USE_BACKEND = true;
  const BACKEND_BASE = 'https://ai-agent-backend.ai-agent-backend.workers.dev';
  const BACKEND_CHAT_URL = BACKEND_BASE + '/api/chat';
  const BACKEND_DEVICES_URL = BACKEND_BASE + '/api/devices';
  // Direct raw-relay command endpoint (no backend changes needed — the Worker
  // already exposes POST /api/command → { ok, result }).
  const BACKEND_COMMAND_URL = BACKEND_BASE + '/api/command';

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
  // permissive when `AGENT_WEB_KEY` is unset, so sending an empty string when the
  // key isn't configured is forward-compatible and causes no regression.
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

    let mediaEl;
    if (item.type === 'video') {
      mediaEl = document.createElement('video');
      mediaEl.controls = true;
      mediaEl.preload = 'metadata';
      mediaEl.playsInline = true;
      mediaEl.src = item.url;
    } else {
      mediaEl = document.createElement('img');
      mediaEl.loading = 'lazy';
      mediaEl.alt = 'Media';
      mediaEl.src = item.url;
      // Telegram serves files as application/octet-stream; re-fetch as a Blob
      // with a sniffed mime so the <img> renders inline instead of downloading.
      renderImageViaBlob(mediaEl, item.url);
    }
    mediaEl.className = 'msg__media-el';

    const dl = document.createElement('a');
    dl.className = 'msg__media-dl';
    dl.href = item.url;
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
    if (/\bmodel\b/.test(d)) return 'model';
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

  async function callBackend(provider, msgs) {
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
    return { content: reply, tools, media, rateLimited: false };
  }

  let isBusy = false;

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
        opt.textContent = (d.online ? '● ' : '○ ') + (d.name || d.model || d.device_id || '?');
        deviceSelect.appendChild(opt);
      });
      deviceSelect.value = prev;
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
      dot.className = 'dot dot--online';
      if (label) label.textContent = device.name || device.model || device.device_id || 'phone';
    } else {
      dot.className = 'dot dot--offline';
      if (label) label.textContent = devicesCache.length ? 'phone offline' : 'no phone';
    }
  }

  if (deviceSelect) {
    deviceSelect.addEventListener('change', () => {
      selectedDeviceId = deviceSelect.value;
      if (selectedDeviceId) localStorage.setItem('aiAgent.deviceId', selectedDeviceId);
      else localStorage.removeItem('aiAgent.deviceId');
      updateStatusDevice();
      refreshStatusBar();
    });
  }

  async function refreshMcpStatus() {
    try {
      const res = await fetch(BACKEND_DEVICES_URL, { headers: { 'X-Web-Key': agentWebKey() } });
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

  async function postCommand(command) {
    const res = await fetch(BACKEND_COMMAND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Web-Key': agentWebKey() },
      body: JSON.stringify({
        command: command,
        ...(selectedDeviceId ? { device_id: selectedDeviceId } : {}),
      }),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      const detail = (data && (data.error || data.message || data.result)) || ('HTTP ' + res.status);
      throw new Error(detail);
    }
    return data;
  }

  // Non-throwing variant used by the status bar / aggregates.
  async function safeCommand(command) {
    try {
      const data = await postCommand(command);
      return (data && typeof data.result !== 'undefined') ? String(data.result) : '';
    } catch (err) {
      return null;
    }
  }

  function renderMedia(resultEl, url, kind) {
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

  async function runCommand(command, kind) {
    if (ccBusy) return;
    ccBusy = true;
    toolResultEl.innerHTML = '';
    const loader = el('div', 'result-loading');
    loader.textContent = 'Running: ' + command;
    toolResultEl.appendChild(loader);
    try {
      const data = await postCommand(command);
      const raw = (data && typeof data.result !== 'undefined') ? data.result : '';
      renderToolResult(toolResultEl, raw, kind || 'auto');
    } catch (err) {
      toolResultEl.innerHTML = '';
      toolResultEl.appendChild(
        el('pre', 'result-pre result-error', '⚠️ ' + (err && err.message ? err.message : 'Request failed'))
      );
    } finally {
      ccBusy = false;
    }
  }

  // Run several commands in sequence and aggregate their text into one card.
  async function runMulti(list) {
    if (ccBusy) return;
    ccBusy = true;
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
    ccBusy = false;
  }

  // ---------------------------------------------------------------------------
  // Control Center — tile rendering + open/close + tilt + particles + status bar
  // ---------------------------------------------------------------------------

  function openTool(tool) {
    gridView.hidden = true;
    toolView.hidden = false;
    // Re-trigger the flip/zoom entry animation.
    toolView.style.animation = 'none';
    void toolView.offsetWidth;
    toolView.style.animation = '';
    toolTitle.textContent = tool.emoji + ' ' + tool.label;
    toolControlsEl.innerHTML = '';
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
    toolView.hidden = true;
    gridView.hidden = false;
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

  function renderGrid() {
    tileGrid.innerHTML = '';
    TOOLS.forEach((tool, i) => {
      const tile = el('button', 'tile');
      tile.type = 'button';
      tile.style.setProperty('--tile-accent', tool.color);
      tile.style.animationDelay = (i * 30) + 'ms';
      tile.appendChild(el('span', 'tile__emoji', tool.emoji));
      tile.appendChild(el('span', 'tile__label', tool.label));
      tile.appendChild(el('span', 'tile__sub', tool.sub));
      tile.addEventListener('click', () => openTool(tool));
      attachTilt(tile);
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

  // Bottom status bar: battery / storage / network quick readout.
  async function refreshStatusBar() {
    const bEl = document.getElementById('statusBattery');
    const sEl = document.getElementById('statusStorage');
    const nEl = document.getElementById('statusNetwork');
    const [battery, storage, network] = await Promise.all([
      safeCommand('battery'),
      safeCommand('storage'),
      safeCommand('network'),
    ]);
    if (bEl) bEl.textContent = battery ? ('🔋 ' + summarizeBattery(battery)) : '🔋 —';
    if (sEl) sEl.textContent = storage ? ('💾 ' + compact(storage, 26)) : '💾 —';
    if (nEl) nEl.textContent = network ? ('📶 ' + compact(network, 22)) : '📶 —';
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
    void gateCard.offsetWidth;
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

  refreshMcpStatus();
  renderMcpTools();
  // Poll device status every 2 min (was 15s — was flooding the free relay).
  setInterval(refreshMcpStatus, 120000);

  // Status bar reads (battery/storage/network) — initial + every 5 min.
  // (Was 30s: 3 commands per poll was flooding the relay with a huge backlog,
  //  which starved media commands like camera/audio and caused timeouts.)
  refreshStatusBar();
  setInterval(refreshStatusBar, 300000);
})();
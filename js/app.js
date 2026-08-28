/**
 * HiveDrop — GitHub Pages friendly LAN chat + file share
 * PeerJS free cloud for signaling · WebRTC DataChannels for P2P (LAN preferred)
 */
(() => {
  'use strict';

  const CHUNK = 64 * 1024; // PeerJS fast chunk (LAN)
  const MQTT_FILE_CHUNK = 24 * 1024; // larger MQTT chunks for speed
  const MQTT_PIPELINE = 4; // parallel chunk publishes
  const MAX_FILE = 100 * 1024 * 1024;
  const MAX_MQTT_FILE = 50 * 1024 * 1024;
  const MAX_BATCH_FILES = 30;
  const PEER_PREFIX = 'hivedrop-';
  const NEARBY_TTL_MS = 90_000;
  const PRESENCE_TOPIC = 'qrtrx/v1/presence';
  const MQTT_URLS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081'
  ];
  const MQTT_SCRIPT_URLS = [
    'https://cdnjs.cloudflare.com/ajax/libs/mqtt/4.3.7/mqtt.min.js',
    'https://unpkg.com/mqtt@4.3.7/dist/mqtt.min.js',
    'https://cdn.jsdelivr.net/npm/mqtt@4.3.7/dist/mqtt.min.js'
  ];

  function getMqttLib() {
    return window.mqtt || globalThis.mqtt || null;
  }

  function loadMqttScript() {
    return new Promise((resolve) => {
      if (getMqttLib()) return resolve(getMqttLib());
      let i = 0;
      const next = () => {
        if (i >= MQTT_SCRIPT_URLS.length) return resolve(null);
        const url = MQTT_SCRIPT_URLS[i++];
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => resolve(getMqttLib());
        s.onerror = () => next();
        document.head.appendChild(s);
      };
      next();
    });
  }

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const el = {
    viewRegister: $('#view-register'),
    viewJoin: $('#view-join'),
    viewRoom: $('#view-room'),
    regNameInput: $('#regNameInput'),
    btnRegister: $('#btnRegister'),
    btnLogout: $('#btnLogout'),
    meNameLabel: $('#meNameLabel'),
    btnRefreshHome: $('#btnRefreshHome'),
    nameInput: $('#nameInput'),
    roomInput: $('#roomInput'),
    btnRandomRoom: $('#btnRandomRoom'),
    btnJoin: $('#btnJoin'),
    btnNearby: $('#btnNearby'),
    btnNearbyInRoom: $('#btnNearbyInRoom'),
    roomBadge: $('#roomBadge'),
    roleBadge: $('#roleBadge'),
    btnQr: $('#btnQr'),
    btnCopy: $('#btnCopy'),
    btnLeave: $('#btnLeave'),
    peerList: $('#peerList'),
    peerCount: $('#peerCount'),
    youLine: $('#youLine'),
    chatLog: $('#chatLog'),
    chatInput: $('#chatInput'),
    btnSendChat: $('#btnSendChat'),
    dropZone: $('#dropZone'),
    fileInput: $('#fileInput'),
    sendTarget: $('#sendTarget'),
    btnSendFiles: $('#btnSendFiles'),
    fileQueue: $('#fileQueue'),
    transferList: $('#transferList'),
    qrModal: $('#qrModal'),
    qrBox: $('#qrBox'),
    qrImg: $('#qrImg'),
    qrRoomBig: $('#qrRoomBig'),
    joinUrl: $('#joinUrl'),
    btnCopyModal: $('#btnCopyModal'),
    nearbyModal: $('#nearbyModal'),
    nearbyList: $('#nearbyList'),
    nearbyStatus: $('#nearbyStatus'),
    btnRefreshNearby: $('#btnRefreshNearby'),
    btnStartCam: $('#btnStartCam'),
    btnStopCam: $('#btnStopCam'),
    camVideo: $('#camVideo'),
    camCanvas: $('#camCanvas'),
    camOverlay: $('#camOverlay'),
    camStatus: $('#camStatus'),
    qrFileInput: $('#qrFileInput'),
    nearbyRoomInput: $('#nearbyRoomInput'),
    btnNearbyJoinCode: $('#btnNearbyJoinCode'),
    tabCamera: $('#tabCamera'),
    tabLive: $('#tabLive'),
    toasts: $('#toasts'),
    statusDot: $('#statusDot'),
    homePeopleList: $('#homePeopleList'),
    homePeopleCount: $('#homePeopleCount'),
    presenceHint: $('#presenceHint'),
    inviteModal: $('#inviteModal'),
    inviteTitle: $('#inviteTitle'),
    inviteSub: $('#inviteSub'),
    inviteMsg: $('#inviteMsg'),
    btnInviteAccept: $('#btnInviteAccept'),
    btnInviteDecline: $('#btnInviteDecline'),
  };

  const state = {
    peer: null,
    id: null,
    name: '',
    room: '',
    isHost: false,
    hostId: '',
    conns: new Map(),
    peers: new Map(),
    pendingFiles: [],
    incoming: new Map(),
    // nearby people (MQTT presence)
    mqtt: null,
    presenceId: '',
    nearbyPeople: new Map(), // id -> { id, name, room, status, ts }
    presenceTimer: null,
    nameDebounce: null,
    camStream: null,
    camRaf: 0,
    scanLock: false,
    mqttReady: false,
    pendingInvite: null,
    inviteRing: null,
    seenInviteKeys: new Set(),
    // groups + message receipts
    groups: [], // { code, name, joinedAt }
    isGroup: false,
    groupName: '',
    chatPartnerName: '',
    msgStatus: new Map(), // mid -> 'sent'|'delivered'|'seen'
    outgoingMids: new Map(), // mid -> { el, status }
    displayedMids: new Set(), // prevent double-render (PeerJS + MQTT)
    sendLock: false,
    chatSessionOpen: false,
    peerRetryTimer: null,
    personalCode: '',
    batchSending: false,
    subscribedGroups: new Set(), // always-on group MQTT topics
    fileInbox: [], // background files when not viewing that chat
  };

  function getPersonalCode() {
    if (state.personalCode) return state.personalCode;
    try {
      let c = localStorage.getItem('hivedrop_share_code');
      if (!c || c.length < 4) {
        c = randomRoom();
        localStorage.setItem('hivedrop_share_code', c);
      }
      state.personalCode = sanitizeRoom(c) || randomRoom();
      localStorage.setItem('hivedrop_share_code', state.personalCode);
      return state.personalCode;
    } catch {
      state.personalCode = randomRoom();
      return state.personalCode;
    }
  }

  function shareUrl(code) {
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('room', code || getPersonalCode());
    u.searchParams.set('share', '1');
    const n = state.name || loadName() || '';
    if (n) u.searchParams.set('from', n);
    return u.toString();
  }

  function renderHomeShareQr() {
    const code = getPersonalCode();
    const box = $('#homeQrBox');
    const img = $('#homeQrImg');
    const codeEl = $('#homeShareCode');
    if (codeEl) codeEl.textContent = code;
    const url = shareUrl(code);
    if (box) {
      box.innerHTML = '';
      box.classList.remove('hidden');
    }
    if (img) {
      img.classList.add('hidden');
      img.removeAttribute('src');
    }
    if (window.QRCode && box) {
      try {
        // eslint-disable-next-line no-new
        new QRCode(box, {
          text: url,
          width: 200,
          height: 200,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel ? QRCode.CorrectLevel.M : 0
        });
        if (box.querySelector('img, canvas')) return;
      } catch (e) { console.warn(e); }
    }
    if (img) {
      box?.classList.add('hidden');
      img.classList.remove('hidden');
      img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=' + encodeURIComponent(url);
    }
  }

  function loadGroups() {
    try {
      state.groups = JSON.parse(localStorage.getItem('hivedrop_groups') || '[]') || [];
    } catch { state.groups = []; }
    return state.groups;
  }
  function saveGroups() {
    try { localStorage.setItem('hivedrop_groups', JSON.stringify(state.groups || [])); } catch {}
  }
  function upsertGroup(code, name) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!code) return null;
    loadGroups();
    const i = state.groups.findIndex((g) => g.code === code);
    const g = { code, name: (name || code).slice(0, 32), joinedAt: Date.now() };
    if (i >= 0) state.groups[i] = { ...state.groups[i], ...g, name: name || state.groups[i].name };
    else state.groups.unshift(g);
    saveGroups();
    renderGroupList();
    subscribeGroupTopic(code); // always stay connected
    return g;
  }
  function groupTopic(code) {
    return PRESENCE_TOPIC + '/group/' + String(code).toUpperCase();
  }

  function subscribeGroupTopic(code) {
    code = sanitizeRoom(code);
    if (!code) return;
    ensureMqtt(() => {
      if (!state.mqtt || !state.mqttReady) return;
      const topic = groupTopic(code);
      if (state.subscribedGroups.has(code)) {
        // still refresh membership ping
        try {
          state.mqtt.publish(topic, JSON.stringify({
            t: 'gpresence',
            fromId: getPresenceId(),
            fromName: state.name || loadName() || '',
            room: code,
            ts: Date.now()
          }), { qos: 0 });
        } catch {}
        return;
      }
      try {
        state.mqtt.subscribe(topic, { qos: 0 });
        state.subscribedGroups.add(code);
        state.mqtt.publish(topic, JSON.stringify({
          t: 'gpresence',
          fromId: getPresenceId(),
          fromName: state.name || loadName() || '',
          room: code,
          ts: Date.now()
        }), { qos: 0 });
      } catch (e) { console.warn(e); }
    });
  }

  function subscribeAllGroups() {
    loadGroups();
    for (const g of state.groups) subscribeGroupTopic(g.code);
  }

  function countOpenPeerConns() {
    let n = 0;
    for (const [id, c] of state.conns) {
      if (id !== state.id && c && c.open) n += 1;
    }
    return n;
  }

  function mqttPublishRaw(topic, obj) {
    return new Promise((resolve) => {
      try {
        if (!state.mqtt || !state.mqttReady) return resolve(false);
        state.mqtt.publish(topic, JSON.stringify(obj), { qos: 0 });
        resolve(true);
      } catch {
        resolve(false);
      }
    });
  }

  function getPresenceId() {
    if (state.presenceId) return state.presenceId;
    try {
      let id = sessionStorage.getItem('hivedrop_pid');
      if (!id) {
        id = 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        sessionStorage.setItem('hivedrop_pid', id);
      }
      state.presenceId = id;
      return id;
    } catch {
      state.presenceId = 'p_' + Math.random().toString(36).slice(2, 12);
      return state.presenceId;
    }
  }

  function peerConfig() {
    return {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    };
  }

  // ── utils ──────────────────────────────────────────────
  function toast(msg, type = '') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    el.toasts.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; setTimeout(() => t.remove(), 250); }, 2800);
  }

  function randomRoom() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }

  function sanitizeRoom(r) {
    const s = String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    // reject garbage like Vundefined...
    if (!s || s.includes('UNDEFINED') || s.length < 4) return '';
    return s;
  }

  function roomFromUrl() {
    const p = new URLSearchParams(location.search);
    return sanitizeRoom(p.get('room') || '');
  }

  function joinUrl() {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('room', state.room);
    return u.toString();
  }

  function loadName() {
    try { return localStorage.getItem('hivedrop_name') || ''; } catch { return ''; }
  }
  function saveName(n) {
    try { localStorage.setItem('hivedrop_name', n); } catch {}
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function timeNow() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function initials(name) {
    const p = (name || '?').trim().split(/\s+/);
    return ((p[0]?.[0] || '?') + (p[1]?.[0] || '')).toUpperCase();
  }

  function setStatus(mode) {
    el.statusDot.classList.remove('on', 'warn');
    if (mode === 'on') el.statusDot.classList.add('on');
    if (mode === 'warn') el.statusDot.classList.add('warn');
  }

  // ── UI ─────────────────────────────────────────────────
  function hideAllViews() {
    el.viewRegister?.classList.remove('active');
    el.viewJoin?.classList.remove('active');
    el.viewRoom?.classList.remove('active');
  }
  function showRegister() {
    hideAllViews();
    el.viewRegister?.classList.add('active');
  }
  function showJoin() {
    hideAllViews();
    el.viewJoin?.classList.add('active');
    if (el.meNameLabel) el.meNameLabel.textContent = state.name || loadName() || '—';
    if (el.nameInput && state.name) el.nameInput.value = state.name;
    renderNearbyList();
    renderGroupList();
    setTimeout(renderHomeShareQr, 100);
  }
  function showRoom() {
    hideAllViews();
    el.viewRoom?.classList.add('active');
  }

  /** Shared private room id for two users (same code both sides) */
  function pairRoomCode(idA, idB) {
    const a = String(idA || 'x');
    const b = String(idB || 'y');
    // never hash real "undefined" strings from bad calls
    const s = [a === 'undefined' ? 'x' : a, b === 'undefined' ? 'y' : b].sort().join('|');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    let x = (h >>> 0) || 1;
    for (let i = 0; i < 6; i++) {
      const idx = Math.abs(x % chars.length);
      out += chars[idx] || 'A';
      x = (Math.floor(x / chars.length) ^ (h >>> ((i * 3) % 16))) >>> 0;
      if (!x) x = (h + i + 1) >>> 0;
    }
    return sanitizeRoom(out) || randomRoom();
  }

  function registerUsername(raw) {
    const name = String(raw || '').trim().slice(0, 24);
    if (name.length < 1) {
      toast('Username type pannunga', 'err');
      el.regNameInput?.focus();
      return false;
    }
    state.name = name;
    saveName(name);
    if (el.nameInput) el.nameInput.value = name;
    if (el.meNameLabel) el.meNameLabel.textContent = name;
    getPersonalCode();
    ensureMqtt(() => {
      try {
        const uname = name.toLowerCase().replace(/\s+/g, '_').slice(0, 32);
        state.mqtt?.subscribe?.(PRESENCE_TOPIC + '/user/' + uname, { qos: 0 });
      } catch {}
    });
    publishPresence(true);
    startPresenceLoop();
    showJoin();
    updatePresenceHint();
    renderHomeShareQr();
    toast(`Hi ${name} · show QR to share`, 'ok');

    // If came from scanned QR with room waiting
    const pendingRoom = sanitizeRoom(el.roomInput?.value || roomFromUrl());
    if (pendingRoom) {
      setTimeout(() => enterRoom(name, pendingRoom), 500);
    }
    return true;
  }

  function addSystem(text) {
    const d = document.createElement('div');
    d.className = 'msg system';
    d.textContent = text;
    el.chatLog.appendChild(d);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function ticksHtml(status) {
    if (!status || status === 'sent') return '<span class="ticks" title="Sent">✓</span>';
    if (status === 'delivered') return '<span class="ticks" title="Delivered">✓✓</span>';
    return '<span class="ticks read" title="Seen">✓✓</span>';
  }

  function playMsgSound() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.08);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.25);
      setTimeout(() => { try { ctx.close(); } catch {} }, 400);
    } catch {}
  }

  function addChat({ name, text, me, file, mid, status, silent }) {
    // Deduplicate: same mid only once (fixes 1 msg → 2 bubbles)
    if (mid) {
      if (state.displayedMids.has(mid)) return null;
      state.displayedMids.add(mid);
      if (state.displayedMids.size > 300) {
        state.displayedMids = new Set([...state.displayedMids].slice(-150));
      }
    }
    const d = document.createElement('div');
    d.className = `msg ${me ? 'me' : 'them'}${file ? ' file-msg' : ''} msg-anim`;
    if (mid) d.dataset.mid = mid;
    const body = file
      ? `📎 <a href="${file.url}" download="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a>
         <span style="opacity:.7;font-size:0.75rem"> (${fmtBytes(file.size)})</span>`
      : escapeHtml(text || '');
    const tick = me ? ticksHtml(status || 'sent') : '';
    d.innerHTML = `
      <span class="who">${escapeHtml(name || '')}</span>
      <div class="body">${body}</div>
      <div class="meta-line">
        <span class="time">${timeNow()}</span>
        ${tick}
      </div>`;
    el.chatLog.appendChild(d);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
    if (me && mid) {
      state.outgoingMids.set(mid, { el: d, status: status || 'sent' });
      state.msgStatus.set(mid, status || 'sent');
    }
    if (!me && !silent) {
      playMsgSound();
      try { navigator.vibrate?.(50); } catch {}
    }
    return d;
  }

  function updateMsgTicks(mid, status) {
    if (!mid || !status) return;
    const cur = state.msgStatus.get(mid);
    const rank = { sent: 1, delivered: 2, seen: 3 };
    if (cur && (rank[status] || 0) <= (rank[cur] || 0)) return;
    state.msgStatus.set(mid, status);
    const rec = state.outgoingMids.get(mid);
    const node = rec?.el || el.chatLog?.querySelector(`.msg[data-mid="${mid}"]`);
    if (!node) return;
    const tickEl = node.querySelector('.ticks');
    if (tickEl) {
      tickEl.outerHTML = ticksHtml(status);
    }
    if (rec) rec.status = status;
  }

  function newMid() {
    return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function renderGroupList() {
    loadGroups();
    const list = $('#groupList');
    const count = $('#groupCount');
    if (count) count.textContent = String(state.groups.length);
    if (!list) return;
    if (!state.groups.length) {
      list.innerHTML = '<li class="nearby-empty">No groups yet.<br/>Create or join with a code</li>';
      return;
    }
    const inboxByRoom = {};
    for (const f of state.fileInbox) {
      inboxByRoom[f.room] = (inboxByRoom[f.room] || 0) + 1;
    }
    list.innerHTML = state.groups.map((g) => {
      const live = state.subscribedGroups.has(g.code);
      const inbox = inboxByRoom[g.code] || 0;
      return `
      <li class="nearby-item group-item" data-code="${escapeHtml(g.code)}" data-name="${escapeHtml(g.name)}">
        <div class="av">👥</div>
        <div class="meta">
          <div class="nm">${escapeHtml(g.name)}${inbox ? ` · 📁${inbox}` : ''}</div>
          <div class="rm"><span class="${live ? 'st-online' : 'st-room'}">${live ? '● Connected' : '○ Reconnecting…'}</span> · <span class="mono">${escapeHtml(g.code)}</span></div>
        </div>
        <span class="join-chip">Open →</span>
      </li>`;
    }).join('');
    list.querySelectorAll('.group-item').forEach((item) => {
      item.addEventListener('click', () => {
        openGroup(item.dataset.code, item.dataset.name);
      });
    });
  }

  function openGroup(code, name) {
    const myName = (state.name || loadName() || '').trim();
    if (!myName) {
      showRegister();
      return;
    }
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!code) return;
    upsertGroup(code, name || code);
    state.isGroup = true;
    state.groupName = name || code;
    state.chatPartnerName = '';
    if (el.roomInput) el.roomInput.value = code;
    if (el.nameInput) el.nameInput.value = myName;
    enterRoom(myName, code);
    // Show any files received while away
    setTimeout(() => flushInboxIntoChat(code), 400);
  }

  function createGroup(name) {
    name = String(name || '').trim().slice(0, 32);
    if (!name) {
      toast('Group name type pannunga', 'err');
      return;
    }
    const code = randomRoom();
    upsertGroup(code, name);
    // announce group on MQTT for discovery
    ensureMqtt(() => {
      try {
        state.mqtt.publish(PRESENCE_TOPIC, JSON.stringify({
          t: 'group-announce',
          code,
          name,
          fromId: getPresenceId(),
          fromName: state.name || loadName(),
          ts: Date.now()
        }), { qos: 0 });
      } catch {}
    });
    toast(`Group “${name}” created`, 'ok');
    openGroup(code, name);
  }

  function joinGroupByCode(code, name) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (code.length < 4) {
      toast('Valid group code enter pannunga', 'err');
      return;
    }
    upsertGroup(code, name || code);
    openGroup(code, name || code);
  }

  function renderPeers() {
    const list = [...state.peers.values()].sort((a, b) => {
      if (a.id === state.id) return -1;
      if (b.id === state.id) return 1;
      return a.name.localeCompare(b.name);
    });
    el.peerCount.textContent = String(list.length);
    el.peerList.innerHTML = list.map((p) => {
      const self = p.id === state.id;
      return `<li class="peer-item${self ? ' self' : ''}${p.isHost ? ' host' : ''}">
        <div class="avatar">${escapeHtml(initials(p.name))}</div>
        <div class="peer-meta">
          <div class="peer-name">${escapeHtml(p.name)}${self ? ' (you)' : ''}</div>
          <div class="peer-role">${p.isHost ? 'host' : 'member'}</div>
        </div>
        <span class="dot"></span>
      </li>`;
    }).join('');

    // send target select
    const cur = el.sendTarget.value;
    el.sendTarget.innerHTML = `<option value="*">Everyone</option>` +
      list.filter((p) => p.id !== state.id).map((p) =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
      ).join('');
    if ([...el.sendTarget.options].some((o) => o.value === cur)) el.sendTarget.value = cur;

    el.youLine.textContent = `You · ${state.name} · ${state.isHost ? 'host' : 'member'}`;
  }

  function renderQueue() {
    if (!state.pendingFiles.length) {
      el.fileQueue.innerHTML = '';
      el.btnSendFiles.disabled = true;
      return;
    }
    el.fileQueue.innerHTML = state.pendingFiles.map((f, i) => `
      <div class="chip">
        <span class="nm" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
        <span class="sz">${fmtBytes(f.size)}</span>
        <button type="button" data-i="${i}" aria-label="Remove">×</button>
      </div>`).join('');
    el.fileQueue.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        state.pendingFiles.splice(Number(b.dataset.i), 1);
        renderQueue();
      });
    });
    // Room/group open aana PeerJS peers illama kooda send allow (MQTT path)
    el.btnSendFiles.disabled = state.pendingFiles.length === 0 || !state.room;
  }

  // ── Peer protocol ──────────────────────────────────────
  function hostPeerId(room) {
    // Short id — PeerJS free cloud is more reliable with short alphanumeric IDs
    return 'qrx' + String(room || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  }

  function send(conn, obj) {
    if (conn && conn.open) {
      try { conn.send(obj); } catch (e) { console.warn(e); }
    }
  }

  function broadcast(obj, exceptId) {
    for (const [id, conn] of state.conns) {
      if (id === exceptId) continue;
      send(conn, obj);
    }
  }

  function wireConn(conn, remoteMeta) {
    if (!conn || state.conns.has(conn.peer)) {
      // already have — still attach if missing handlers? skip
      if (state.conns.has(conn.peer)) return state.conns.get(conn.peer);
    }

    state.conns.set(conn.peer, conn);

    conn.on('data', (data) => onData(conn.peer, data));
    conn.on('close', () => onPeerLeft(conn.peer));
    conn.on('error', (err) => console.warn('conn error', err));

    conn.on('open', () => {
      // Introduce ourselves
      send(conn, {
        t: 'hello',
        id: state.id,
        name: state.name,
        isHost: state.isHost,
        room: state.room
      });

      if (state.isHost) {
        // Send roster to newcomer
        send(conn, {
          t: 'roster',
          peers: [...state.peers.values()]
        });
        // Ask existing peers to mesh-connect to newcomer
        broadcast({
          t: 'peer-join',
          peer: { id: conn.peer, name: remoteMeta?.name || 'Guest', isHost: false }
        }, conn.peer);
      }
    });

    // If already open
    if (conn.open) {
      send(conn, {
        t: 'hello',
        id: state.id,
        name: state.name,
        isHost: state.isHost,
        room: state.room
      });
    }

    return conn;
  }

  function connectTo(peerId) {
    if (!state.peer || peerId === state.id || state.conns.has(peerId)) return;
    try {
      const conn = state.peer.connect(peerId, { reliable: true, serialization: 'binary' });
      // peerjs may use json for objects if not binary - use default json for control, binary for files
      // Actually mixed is hard; use default JSON serialization and ArrayBuffer as base64 or chunked Uint8Array
      wireConn(conn);
    } catch (e) {
      console.warn('connect fail', peerId, e);
    }
  }

  // Use JSON-friendly connections (default)
  function connectToJson(peerId) {
    if (!state.peer || peerId === state.id || state.conns.has(peerId)) return;
    try {
      const conn = state.peer.connect(peerId, { reliable: true });
      wireConn(conn);
    } catch (e) {
      console.warn(e);
    }
  }

  function onPeerLeft(peerId) {
    const p = state.peers.get(peerId);
    state.conns.delete(peerId);
    state.peers.delete(peerId);
    renderPeers();
    renderQueue();
    if (p) addSystem(`${p.name} left`);
    if (state.isHost) {
      broadcast({ t: 'peer-left', id: peerId });
    }
  }

  function onData(fromId, data) {
    if (!data || typeof data !== 'object') return;

    switch (data.t) {
      case 'hello': {
        state.peers.set(data.id || fromId, {
          id: data.id || fromId,
          name: data.name || 'Guest',
          isHost: !!data.isHost
        });
        renderPeers();
        renderQueue();
        addSystem(`${data.name || 'Someone'} joined`);
        break;
      }
      case 'roster': {
        for (const p of data.peers || []) {
          state.peers.set(p.id, p);
          if (p.id !== state.id) connectToJson(p.id);
        }
        renderPeers();
        renderQueue();
        break;
      }
      case 'peer-join': {
        const p = data.peer;
        if (!p?.id || p.id === state.id) break;
        state.peers.set(p.id, p);
        connectToJson(p.id);
        renderPeers();
        renderQueue();
        break;
      }
      case 'peer-left': {
        onPeerLeft(data.id);
        break;
      }
      case 'chat': {
        const mid = data.mid || '';
        const d = addChat({
          name: data.name || 'Guest',
          text: data.text,
          me: false,
          mid
        });
        if (d && data.fromId) d.dataset.fromId = data.fromId;
        // delivery ack
        sendDeliveryAck(mid, data.fromId || fromId, 'delivered');
        // seen if chat visible
        if (document.visibilityState === 'visible' && el.viewRoom?.classList.contains('active')) {
          setTimeout(() => sendDeliveryAck(mid, data.fromId || fromId, 'seen'), 300);
        }
        try { navigator.vibrate?.(40); } catch {}
        break;
      }
      case 'msg-ack': {
        if (data.mid && (!data.to || data.to === getPresenceId() || data.to === state.id)) {
          updateMsgTicks(data.mid, data.kind === 'seen' ? 'seen' : 'delivered');
        }
        break;
      }
      case 'file-meta': {
        // prepare receive
        state.incoming.set(data.fid, {
          fid: data.fid,
          name: data.name,
          size: data.size,
          mime: data.mime || 'application/octet-stream',
          fromName: data.fromName || 'Someone',
          fromId,
          chunks: [],
          received: 0,
          total: data.size
        });
        showTransfer(data.fid, data.name, 0, `Receiving from ${data.fromName}…`);
        break;
      }
      case 'file-chunk': {
        const rec = state.incoming.get(data.fid);
        if (!rec) break;
        // data.chunk is array of bytes or base64
        let u8;
        if (typeof data.chunk === 'string') {
          const bin = atob(data.chunk);
          u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        } else if (data.chunk?.data) {
          u8 = new Uint8Array(data.chunk.data);
        } else {
          u8 = new Uint8Array(data.chunk);
        }
        rec.chunks.push(u8);
        rec.received += u8.length;
        const pct = Math.min(100, (rec.received / rec.total) * 100);
        showTransfer(data.fid, rec.name, pct, `Receiving… ${fmtBytes(rec.received)}`);
        break;
      }
      case 'file-end': {
        const rec = state.incoming.get(data.fid);
        if (!rec) break;
        const blob = new Blob(rec.chunks, { type: rec.mime });
        const url = URL.createObjectURL(blob);
        showTransfer(data.fid, rec.name, 100, 'Done');
        // mid dedupes against MQTT gfile path
        addChat({
          name: rec.fromName,
          me: false,
          mid: 'file_' + data.fid,
          file: { url, name: rec.name, size: rec.size }
        });
        toast(`File from ${rec.fromName}`, 'ok');
        try { navigator.vibrate?.(80); } catch {}
        state.incoming.delete(data.fid);
        setTimeout(() => removeTransfer(data.fid), 2500);
        break;
      }
      default:
        break;
    }
  }

  // ── Transfers UI ───────────────────────────────────────
  function showTransfer(id, name, pct, label) {
    let row = document.getElementById('xfer-' + id);
    if (!row) {
      row = document.createElement('div');
      row.id = 'xfer-' + id;
      row.className = 'xfer';
      el.transferList.prepend(row);
    }
    row.innerHTML = `
      <div>${escapeHtml(name)} · ${escapeHtml(label || '')}</div>
      <div class="bar"><div class="fill" style="width:${pct}%"></div></div>`;
  }
  function removeTransfer(id) {
    document.getElementById('xfer-' + id)?.remove();
  }

  function u8ToB64(u8) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function setBatchUI(on, text, pct) {
    const wrap = $('#batchProgress');
    const label = $('#batchLabel');
    const fill = $('#batchFill');
    if (!wrap) return;
    wrap.classList.toggle('hidden', !on);
    if (label && text) label.textContent = text;
    if (fill && pct != null) fill.style.width = `${Math.min(100, pct)}%`;
  }

  /**
   * FAST batch share:
   * - If PeerJS peers online (same Wi‑Fi) → WebRTC big chunks (very fast)
   * - Else → pipelined MQTT (always works for group)
   * Groups stay subscribed anytime so receivers get files even on home screen.
   */
  async function sendFilesInRoom(files) {
    let list = files || [...state.pendingFiles];
    if (!list.length) return;
    if (!state.room) {
      toast('Open a chat/group first', 'err');
      return;
    }
    if (state.batchSending) {
      toast('Already sharing files… wait', 'ok');
      return;
    }

    // Ensure MQTT group sub + Peer mesh before send
    subscribeGroupTopic(state.room);
    if (window.Peer && countOpenPeerConns() === 0) {
      startPeerMeshBackground(state.name || loadName(), state.room);
      await new Promise((r) => setTimeout(r, 800));
    }
    if (!state.mqttReady) {
      toast('Connecting…', 'ok');
      ensureMqtt();
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!state.mqttReady) {
      toast('Network not ready — retry', 'err');
      return;
    }

    if (list.length > MAX_BATCH_FILES) {
      toast(`Max ${MAX_BATCH_FILES} — first ${MAX_BATCH_FILES} send`, 'ok');
      list = list.slice(0, MAX_BATCH_FILES);
    }

    state.batchSending = true;
    const total = list.length;
    const fromName = state.name || loadName() || 'Someone';
    let okCount = 0;
    let failCount = 0;
    const fastPeer = countOpenPeerConns() >= 1;
    const mode = fastPeer ? 'FAST (Wi‑Fi)' : 'CLOUD';

    await mqttPublishGroup({
      t: 'gfile-batch',
      count: total,
      fromId: getPresenceId(),
      fromName,
      room: state.room,
      mode,
      ts: Date.now()
    });
    addSystem(`Sharing ${total} file(s) · ${mode}`);
    setBatchUI(true, `0 / ${total} · ${mode}`, 0);
    toast(`${total} files · ${mode}`, 'ok');

    for (let n = 0; n < list.length; n++) {
      const file = list[n];
      setBatchUI(true, `${n + 1}/${total} · ${file.name}`, (n / total) * 100);
      if (file.size > MAX_FILE) {
        failCount += 1;
        toast(`${file.name} skipped (too large)`, 'err');
        continue;
      }
      try {
        const fid = 'f_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
        const mime = file.type || 'application/octet-stream';
        const localUrl = URL.createObjectURL(file);
        addChat({
          name: fromName, me: true, mid: 'file_' + fid,
          file: { url: localUrl, name: file.name, size: file.size }, status: 'sent'
        });

        const usePeerNow = countOpenPeerConns() >= 1;
        if (usePeerNow) {
          await sendOneFilePeerFast(file, fid, fromName, mime, n, total);
        } else {
          await sendOneFileMqttFast(file, fid, fromName, mime, n, total);
        }
        okCount += 1;
        updateMsgTicks('file_' + fid, 'delivered');
        setTimeout(() => removeTransfer(fid), 2000);
      } catch (e) {
        console.warn(e);
        failCount += 1;
        toast(`${file.name} failed`, 'err');
      }
    }

    setBatchUI(true, `Done · ${okCount}/${total}` + (failCount ? ` · ${failCount} fail` : ''), 100);
    addSystem(`Shared ${okCount}/${total} · ${mode}`);
    toast(`${okCount} files send ✓`, 'ok');
    setTimeout(() => setBatchUI(false), 3500);
    state.pendingFiles = [];
    state.batchSending = false;
    renderQueue();
  }

  async function sendOneFilePeerFast(file, fid, fromName, mime, n, total) {
    const targets = [...state.conns.entries()].filter(([id, c]) => id !== state.id && c?.open);
    showTransfer(fid, file.name, 0, `${n + 1}/${total} FAST…`);
    // Also notify group via MQTT meta+end so members without peer still get MQTT path if we dual-send small? 
    // For max speed when peers exist: PeerJS only + MQTT announce for inbox toast
    await mqttPublishGroup({
      t: 'gfile-meta', fid, name: file.name, size: file.size, mime,
      fromId: getPresenceId(), fromName, room: state.room,
      totalChunks: Math.ceil(file.size / CHUNK) || 1,
      batchIndex: n + 1, batchTotal: total, via: 'peer', ts: Date.now()
    });

    for (const [, conn] of targets) {
      send(conn, {
        t: 'file-meta', fid, name: file.name, size: file.size, mime,
        fromName, fromId: getPresenceId()
      });
    }

    const buf = new Uint8Array(await file.arrayBuffer());
    let offset = 0;
    while (offset < buf.length) {
      const slice = buf.subarray(offset, offset + CHUNK);
      const b64 = u8ToB64(slice);
      for (const [, conn] of targets) {
        send(conn, { t: 'file-chunk', fid, chunk: b64 });
      }
      // parallel MQTT pipeline for members not on PeerJS
      mqttPublishGroup({
        t: 'gfile-chunk', fid, index: Math.floor(offset / CHUNK),
        chunk: b64, room: state.room, fromId: getPresenceId()
      });
      offset += slice.length;
      showTransfer(fid, file.name, (offset / buf.length) * 100, `${n + 1}/${total} FAST ${fmtBytes(offset)}`);
      await new Promise((r) => setTimeout(r, 0)); // yield only
    }

    for (const [, conn] of targets) send(conn, { t: 'file-end', fid });
    await mqttPublishGroup({
      t: 'gfile-end', fid, room: state.room, fromId: getPresenceId(),
      name: file.name, size: file.size, mime, fromName,
      batchIndex: n + 1, batchTotal: total, ts: Date.now()
    });
    showTransfer(fid, file.name, 100, `${n + 1}/${total} ✓ FAST`);
  }

  async function sendOneFileMqttFast(file, fid, fromName, mime, n, total) {
    const totalChunks = Math.ceil(file.size / MQTT_FILE_CHUNK) || 1;
    showTransfer(fid, file.name, 0, `${n + 1}/${total} uploading…`);
    await mqttPublishGroup({
      t: 'gfile-meta', fid, name: file.name, size: file.size, mime,
      fromId: getPresenceId(), fromName, room: state.room, totalChunks,
      batchIndex: n + 1, batchTotal: total, via: 'mqtt', ts: Date.now()
    });

    const buf = new Uint8Array(await file.arrayBuffer());
    let offset = 0;
    let index = 0;
    const pending = [];
    while (offset < buf.length) {
      const slice = buf.subarray(offset, offset + MQTT_FILE_CHUNK);
      const b64 = u8ToB64(slice);
      pending.push(mqttPublishGroup({
        t: 'gfile-chunk', fid, index, chunk: b64,
        room: state.room, fromId: getPresenceId()
      }));
      offset += slice.length;
      index += 1;
      if (pending.length >= MQTT_PIPELINE) {
        await Promise.all(pending.splice(0, MQTT_PIPELINE));
      }
      showTransfer(fid, file.name, (offset / buf.length) * 100, `${n + 1}/${total} · ${fmtBytes(offset)}`);
    }
    if (pending.length) await Promise.all(pending);

    await mqttPublishGroup({
      t: 'gfile-end', fid, room: state.room, fromId: getPresenceId(),
      name: file.name, size: file.size, mime, fromName,
      batchIndex: n + 1, batchTotal: total, ts: Date.now()
    });
    showTransfer(fid, file.name, 100, `${n + 1}/${total} ✓`);
  }

  function mqttPublishGroup(obj) {
    return new Promise((resolve) => {
      ensureMqtt(() => {
        if (!state.mqtt || !state.mqttReady || !state.room) {
          resolve(false);
          return;
        }
        try {
          state.mqtt.publish(groupTopic(state.room), JSON.stringify(obj), { qos: 0 });
          setTimeout(() => resolve(true), 20);
        } catch (e) {
          console.warn(e);
          resolve(false);
        }
      });
    });
  }

  function b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function handleGFileMeta(data) {
    if (!data?.fid) return;
    if (!state.mqttIncoming) state.mqttIncoming = new Map();
    if (state.mqttIncoming.has(data.fid)) return;
    state.mqttIncoming.set(data.fid, {
      fid: data.fid,
      name: data.name || 'file',
      size: data.size || 0,
      mime: data.mime || 'application/octet-stream',
      fromName: data.fromName || 'Someone',
      fromId: data.fromId,
      chunks: {},
      received: 0,
      total: data.size || 0,
      totalChunks: data.totalChunks || 0
    });
    const batch = (data.batchIndex && data.batchTotal)
      ? `${data.batchIndex}/${data.batchTotal} · `
      : '';
    showTransfer(data.fid, data.name, 0, `${batch}Receiving from ${data.fromName}…`);
    if (!data.batchIndex || data.batchIndex === 1) {
      toast(`${data.fromName} files share panran…`, 'ok');
    }
  }

  function handleGFileChunk(data) {
    if (!state.mqttIncoming) state.mqttIncoming = new Map();
    const rec = state.mqttIncoming.get(data.fid);
    if (!rec || !data.chunk) return;
    const u8 = b64ToU8(data.chunk);
    const idx = data.index;
    if (idx != null && rec.chunks[idx]) return; // dup chunk
    if (idx != null) rec.chunks[idx] = u8;
    else rec.chunks[Object.keys(rec.chunks).length] = u8;
    rec.received += u8.length;
    const pct = rec.total ? Math.min(99, (rec.received / rec.total) * 100) : 0;
    showTransfer(data.fid, rec.name, pct, `Receiving… ${fmtBytes(rec.received)}`);
  }

  function handleGFileEnd(data, inThisChat = true) {
    if (!state.mqttIncoming) state.mqttIncoming = new Map();
    const rec = state.mqttIncoming.get(data.fid);
    if (!rec) return;
    const keys = Object.keys(rec.chunks).map(Number).sort((a, b) => a - b);
    const parts = keys.map((k) => rec.chunks[k]);
    const blob = new Blob(parts, { type: rec.mime });
    const url = URL.createObjectURL(blob);
    const room = sanitizeRoom(data.room || state.room);
    showTransfer(data.fid, rec.name, 100, 'Ready ✓');

    if (inThisChat && el.viewRoom?.classList.contains('active')) {
      addChat({
        name: rec.fromName,
        me: false,
        mid: 'file_' + data.fid,
        file: { url, name: rec.name, size: rec.size || blob.size }
      });
    } else {
      // Background: keep in inbox, group stays connected
      state.fileInbox.push({
        fid: data.fid,
        name: rec.name,
        size: rec.size || blob.size,
        url,
        fromName: rec.fromName,
        room,
        ts: Date.now()
      });
      if (state.fileInbox.length > 80) state.fileInbox = state.fileInbox.slice(-60);
      renderGroupList();
    }
    playMsgSound();
    toast(`📁 ${rec.name} ready — open group to download`, 'ok');
    try { navigator.vibrate?.(100); } catch {}
    state.mqttIncoming.delete(data.fid);
    setTimeout(() => removeTransfer(data.fid), 4000);
  }

  function flushInboxIntoChat(room) {
    room = sanitizeRoom(room);
    if (!room || !el.chatLog) return;
    const keep = [];
    for (const f of state.fileInbox) {
      if (sanitizeRoom(f.room) === room) {
        addChat({
          name: f.fromName || 'Member',
          me: false,
          mid: 'file_' + f.fid,
          file: { url: f.url, name: f.name, size: f.size }
        });
      } else keep.push(f);
    }
    state.fileInbox = keep;
    renderGroupList();
  }

  async function sendFilesTo(targets) {
    // Prefer MQTT group share whenever we have a room (group OR 1:1 share room)
    if (state.room) {
      await sendFilesInRoom();
      return;
    }

    const files = [...state.pendingFiles];
    if (!files.length || !targets.length) {
      toast('No one to send to — open chat/group first', 'err');
      return;
    }

    for (const file of files) {
      if (file.size > MAX_FILE) {
        toast(`${file.name} too large (max ~80MB)`, 'err');
        continue;
      }
      const fid = 'f_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const meta = {
        t: 'file-meta',
        fid,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        fromName: state.name,
        fromId: getPresenceId()
      };

      for (const tid of targets) {
        const conn = state.conns.get(tid);
        if (conn) send(conn, meta);
      }

      // local echo as outgoing file note
      addSystem(`Sending ${file.name}…`);
      showTransfer(fid, file.name, 0, 'Sending…');

      const buf = new Uint8Array(await file.arrayBuffer());
      let offset = 0;
      while (offset < buf.length) {
        const slice = buf.subarray(offset, offset + CHUNK);
        const payload = {
          t: 'file-chunk',
          fid,
          chunk: u8ToB64(slice)
        };
        for (const tid of targets) {
          const conn = state.conns.get(tid);
          if (conn) send(conn, payload);
        }
        offset += slice.length;
        const pct = (offset / buf.length) * 100;
        showTransfer(fid, file.name, pct, `Sending… ${fmtBytes(offset)}`);
        // yield to UI / network
        await new Promise((r) => setTimeout(r, 0));
      }

      for (const tid of targets) {
        const conn = state.conns.get(tid);
        if (conn) send(conn, { t: 'file-end', fid });
      }

      // Local downloadable copy of what we sent
      const url = URL.createObjectURL(file);
      addChat({
        name: state.name,
        me: true,
        file: { url, name: file.name, size: file.size }
      });
      showTransfer(fid, file.name, 100, 'Sent');
      setTimeout(() => removeTransfer(fid), 2000);
    }

    state.pendingFiles = [];
    renderQueue();
    toast('Files sent', 'ok');
  }

  function sendChat() {
    const text = el.chatInput.value.trim();
    if (!text) return;
    // Prevent double-fire (click + enter, or double bind)
    if (state.sendLock) return;
    state.sendLock = true;
    setTimeout(() => { state.sendLock = false; }, 350);

    const mid = newMid();
    const fromName = state.name || loadName() || 'Someone';
    const payload = {
      t: 'chat',
      mid,
      name: fromName,
      text,
      id: state.id,
      fromId: getPresenceId(),
      room: state.room,
      ts: Date.now()
    };
    // Local bubble once
    addChat({ name: fromName, text, me: true, mid, status: 'sent' });
    el.chatInput.value = '';

    // Transport: PeerJS mesh
    broadcast(payload);

    // MQTT: ONE channel only (avoid double receive)
    // groups → group topic; 1:1 → presence chat-relay
    if (state.isGroup && state.room) {
      ensureMqtt(() => {
        try {
          state.mqtt.publish(groupTopic(state.room), JSON.stringify({
            t: 'gchat',
            mid,
            fromId: getPresenceId(),
            fromName,
            text,
            room: state.room,
            ts: Date.now()
          }), { qos: 0 });
        } catch {}
      });
    } else {
      mqttRelayChat(text, state.chatPartnerName || '', mid);
    }
  }

  function mqttRelayChat(text, toName, mid) {
    if (!text) return;
    const fromName = state.name || loadName() || 'Someone';
    ensureMqtt(() => {
      if (!state.mqtt || !state.mqttReady) return;
      try {
        state.mqtt.publish(PRESENCE_TOPIC, JSON.stringify({
          t: 'chat-relay',
          mid: mid || newMid(),
          fromName,
          fromId: getPresenceId(),
          toName: toName || '',
          room: state.room || '',
          text: String(text).slice(0, 4000),
          broadcast: !toName,
          ts: Date.now()
        }), { qos: 0 });
      } catch (e) {
        console.warn(e);
      }
    });
  }

  function sendDeliveryAck(mid, fromId, kind) {
    // kind: delivered | seen
    if (!mid) return;
    ensureMqtt(() => {
      try {
        state.mqtt.publish(PRESENCE_TOPIC, JSON.stringify({
          t: 'msg-ack',
          mid,
          kind: kind || 'delivered',
          to: fromId,
          fromId: getPresenceId(),
          room: state.room || '',
          ts: Date.now()
        }), { qos: 0 });
      } catch {}
    });
    // also via peer mesh
    broadcast({
      t: 'msg-ack',
      mid,
      kind: kind || 'delivered',
      to: fromId,
      fromId: getPresenceId()
    });
  }

  function markVisibleMessagesSeen() {
    // When chat open, mark last incoming as seen
    if (!el.viewRoom?.classList.contains('active')) return;
    el.chatLog?.querySelectorAll('.msg.them[data-mid]').forEach((node) => {
      const mid = node.dataset.mid;
      const fromId = node.dataset.fromId;
      if (mid) sendDeliveryAck(mid, fromId, 'seen');
    });
  }

  // ── Bootstrap peer ─────────────────────────────────────
  function destroyPeer() {
    // Room mesh only — keep MQTT presence online
    try {
      for (const c of state.conns.values()) c.close();
    } catch {}
    state.conns.clear();
    state.peers.clear();
    try { state.peer?.destroy(); } catch {}
    state.peer = null;
    state.id = null;
    state.isHost = false;
    setStatus('');
  }

  /**
   * STABLE CHAT: MQTT session first (never kick user out).
   * PeerJS only for files — optional background mesh.
   */
  function enterRoom(name, room) {
    room = sanitizeRoom(room) || randomRoom();
    state.name = name;
    state.room = room;
    saveName(name);
    publishPresence(true);

    // Always open chat UI via MQTT — Quick Share style, no drop
    openMqttChatSession(name, room);

    // PeerJS for files in background (failures do NOT exit chat)
    if (window.Peer) {
      startPeerMeshBackground(name, room);
    } else {
      const sub = $('#chatSub');
      if (sub) sub.textContent = 'Chat live · files need refresh';
    }
  }

  function openMqttChatSession(name, room) {
    const already = state.chatSessionOpen && sanitizeRoom(state.room) === room;
    state.chatSessionOpen = true;
    state.room = room;

    ensureMqtt(() => {
      try {
        state.mqtt.subscribe(groupTopic(room), { qos: 0 });
        state.mqtt.publish(groupTopic(room), JSON.stringify({
          t: 'gjoin',
          fromId: getPresenceId(),
          fromName: name,
          room,
          groupName: state.groupName || '',
          ts: Date.now()
        }), { qos: 0 });
      } catch (e) { console.warn(e); }
    });

    if (!already) {
      onJoined();
    } else {
      showRoom();
      updateChatHeader();
    }
  }

  function updateChatHeader() {
    const title = $('#chatTitle');
    const sub = $('#chatSub');
    if (state.isGroup) {
      if (title) title.textContent = state.groupName || ('Group ' + state.room);
      if (sub) sub.className = 'chat-sub live';
      if (sub) sub.textContent = `Group · ${state.room} · chat stable`;
    } else if (state.chatPartnerName) {
      if (title) title.textContent = state.chatPartnerName;
      if (sub) { sub.className = 'chat-sub live'; sub.textContent = 'Connected · chat stable'; }
    } else {
      if (title) title.textContent = state.name ? `${state.name}'s share` : ('Chat ' + state.room);
      if (sub) { sub.className = 'chat-sub live'; sub.textContent = `Code ${state.room} · online`; }
    }
    if (el.roomBadge) el.roomBadge.textContent = state.room;
  }

  function startPeerMeshBackground(name, room) {
    // Soft: clear old peer without wiping chat session
    try {
      if (state.peerRetryTimer) {
        clearTimeout(state.peerRetryTimer);
        state.peerRetryTimer = null;
      }
      for (const c of state.conns.values()) {
        try { c.close(); } catch {}
      }
      state.conns.clear();
      try { state.peer?.destroy(); } catch {}
      state.peer = null;
      state.id = null;
      state.peers.clear();
    } catch {}

    const hid = hostPeerId(room);
    state.hostId = hid;
    let settled = false;

    const hostPeer = new Peer(hid, peerConfig());

    const asClient = () => {
      if (settled) return;
      settled = true;
      try { hostPeer.destroy(); } catch {}
      softPeerClient(name, room, hid);
    };

    hostPeer.on('open', (id) => {
      if (settled) return;
      settled = true;
      state.peer = hostPeer;
      state.id = id;
      state.isHost = true;
      state.peers.set(id, { id, name, isHost: true });
      renderPeers();
      const sub = $('#chatSub');
      if (sub) { sub.className = 'chat-sub live'; sub.textContent = `Live · files ready · ${state.room}`; }
      setStatus('on');
    });

    hostPeer.on('connection', (conn) => {
      wireConn(conn);
      state.peers.set(conn.peer, { id: conn.peer, name: '…', isHost: false });
      renderPeers();
    });

    hostPeer.on('error', (err) => {
      console.warn('host peer', err?.type || err);
      if (err?.type === 'unavailable-id') asClient();
      // never leave chat UI
    });

    hostPeer.on('disconnected', () => {
      try { hostPeer.reconnect(); } catch {}
    });

    setTimeout(() => { if (!settled) asClient(); }, 4000);
  }

  function softPeerClient(name, room, hid) {
    const client = new Peer(peerConfig());
    state.peer = client;
    state.isHost = false;
    state.hostId = hid;

    client.on('open', (id) => {
      state.id = id;
      state.peers.set(id, { id, name, isHost: false });
      try {
        const conn = client.connect(hid, { reliable: true });
        wireConn(conn);
        conn.on('open', () => {
          if (!state.peers.has(hid)) {
            state.peers.set(hid, { id: hid, name: 'Peer', isHost: true });
          }
          renderPeers();
          const sub = $('#chatSub');
          if (sub) { sub.className = 'chat-sub live'; sub.textContent = `Live · files ready · ${room}`; }
          setStatus('on');
        });
      } catch (e) { console.warn(e); }
    });

    client.on('connection', (conn) => wireConn(conn));

    client.on('error', (err) => {
      console.warn('client peer', err?.type || err);
      // Retry quietly — do NOT exit chat
      if (state.chatSessionOpen && state.room === room) {
        state.peerRetryTimer = setTimeout(() => {
          if (state.chatSessionOpen && state.room === room) {
            startPeerMeshBackground(name, room);
          }
        }, 5000);
      }
    });

    client.on('disconnected', () => {
      try { client.reconnect(); } catch {}
    });
  }

  function onJoined() {
    if (el.btnJoin) {
      el.btnJoin.disabled = false;
      el.btnJoin.textContent = 'Enter room code';
    }
    if (el.roleBadge) el.roleBadge.textContent = 'LIVE';
    updateChatHeader();
    if (state.isGroup && state.room) upsertGroup(state.room, state.groupName || state.room);

    showRoom();
    renderPeers();
    renderQueue();
    // Keep history if re-opening same room mid-session
    if (!el.chatLog.dataset.room || el.chatLog.dataset.room !== state.room) {
      el.chatLog.innerHTML = '';
      el.chatLog.dataset.room = state.room;
      state.outgoingMids.clear();
      state.displayedMids.clear();
      addSystem(state.isGroup
        ? `Group “${state.groupName || state.room}” · chat stable · share files below`
        : `Chat open · scan your QR / wait · messages stay connected`);
    }
    setStatus('on');
    toast(state.isGroup ? 'Group open' : 'Chat connected', 'ok');

    const u = new URL(location.href);
    u.searchParams.set('room', state.room);
    u.searchParams.set('share', '1');
    if (state.isGroup) u.searchParams.set('group', '1');
    if (state.groupName) u.searchParams.set('gname', state.groupName);
    history.replaceState(null, '', u);

    startAnnouncing();
    setTimeout(markVisibleMessagesSeen, 500);
  }

  // ── QR (reliable multi-fallback) ───────────────────────
  function openQr() {
    const url = (() => {
      const u = new URL(location.href);
      u.search = '';
      u.searchParams.set('room', state.room || '');
      if (state.isGroup) {
        u.searchParams.set('group', '1');
        if (state.groupName) u.searchParams.set('gname', state.groupName);
      }
      return u.toString();
    })();
    if (el.joinUrl) el.joinUrl.textContent = url;
    if (el.qrRoomBig) el.qrRoomBig.textContent = state.room || '';
    const qt = $('#qrModalTitle');
    if (qt) qt.textContent = state.isGroup ? 'Group invite QR' : 'Scan to join';
    el.qrModal.classList.remove('hidden');
    renderQr(url);
  }
  function closeQr() { el.qrModal.classList.add('hidden'); }

  function renderQr(url) {
    // Reset
    if (el.qrBox) {
      el.qrBox.innerHTML = '';
      el.qrBox.classList.remove('hidden');
    }
    if (el.qrImg) {
      el.qrImg.classList.add('hidden');
      el.qrImg.removeAttribute('src');
    }

    // 1) qrcodejs (davidshimjs) — works offline after CDN load
    if (window.QRCode && el.qrBox) {
      try {
        // qrcodejs constructor paints into container
        // eslint-disable-next-line no-new
        new QRCode(el.qrBox, {
          text: url,
          width: 240,
          height: 240,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel ? QRCode.CorrectLevel.M : 0
        });
        // If library painted something, done
        if (el.qrBox.querySelector('img, canvas')) {
          return;
        }
      } catch (e) {
        console.warn('qrcodejs failed', e);
      }
    }

    // 2) Public QR image API (always works with internet)
    if (el.qrImg) {
      el.qrBox?.classList.add('hidden');
      el.qrImg.classList.remove('hidden');
      el.qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data=' + encodeURIComponent(url);
      el.qrImg.onerror = () => {
        // 3) Google chart API last resort
        el.qrImg.src = 'https://chart.googleapis.com/chart?cht=qr&chs=260x260&chld=M|1&chl=' + encodeURIComponent(url);
      };
      return;
    }

    toast('QR library failed — copy link instead', 'err');
  }

  async function copyLink() {
    const url = joinUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied', 'ok');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('Link copied', 'ok');
    }
  }

  function leave() {
    // Leave chat UI only — GROUP MQTT stays subscribed (always connected)
    state.chatSessionOpen = false;
    if (state.peerRetryTimer) {
      clearTimeout(state.peerRetryTimer);
      state.peerRetryTimer = null;
    }
    destroyPeer();
    state.room = '';
    state.isHost = false;
    state.isGroup = false;
    state.groupName = '';
    state.chatPartnerName = '';
    publishPresence(true);
    subscribeAllGroups(); // keep all groups live
    const u = new URL(location.href);
    u.searchParams.delete('room');
    u.searchParams.delete('group');
    u.searchParams.delete('gname');
    u.searchParams.delete('share');
    u.searchParams.delete('from');
    history.replaceState(null, '', u.pathname + u.hash);
    showJoin();
    renderGroupList();
    renderHomeShareQr();
    toast('Home · groups still connected');
    updatePresenceHint();
  }

  // ── Nearby people via MQTT (name type → show up) ───────
  function openNearby() {
    el.nearbyModal.classList.remove('hidden');
    state.scanLock = false;
    ensureMqtt();
    publishPresence(true);
    switchNearbyTab('live');
    renderNearbyList();
  }

  function closeNearby() {
    stopCamera();
    el.nearbyModal.classList.add('hidden');
  }

  function switchNearbyTab(name) {
    $$('.nearby-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    el.tabCamera.classList.toggle('active', name === 'camera');
    el.tabLive.classList.toggle('active', name === 'live');
    if (name === 'live') {
      stopCamera();
      ensureMqtt();
      publishPresence(true);
      renderNearbyList();
    } else if (name === 'camera') {
      setTimeout(() => startCamera(), 200);
    }
  }

  function prunePeople() {
    const now = Date.now();
    for (const [id, p] of state.nearbyPeople) {
      if (now - p.ts > NEARBY_TTL_MS) state.nearbyPeople.delete(id);
    }
  }

  function upsertPerson(p) {
    if (!p?.id || !p?.name) return;
    // ignore ourselves handled in list; still store for count
    const name = String(p.name).trim().slice(0, 24);
    if (!name || name.includes('undefined')) return;
    const room = sanitizeRoom(p.room);
    // IMPORTANT: use local receive time for TTL (remote clocks break nearby)
    state.nearbyPeople.set(p.id, {
      id: p.id,
      name,
      room,
      status: room ? 'room' : (p.status || 'online'),
      ts: Date.now()
    });
  }

  function personRowHtml(p, me) {
    // Username-only list (user request)
    const chip = me ? 'You' : 'Chat →';
    return `<li class="nearby-item${me ? ' me-item' : ''}" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">
      <div class="av">${escapeHtml(initials(p.name))}</div>
      <div class="meta">
        <div class="nm">${escapeHtml(p.name)}${me ? ' (you)' : ''}</div>
        <div class="rm"><span class="st-online">● Online</span></div>
      </div>
      <span class="join-chip">${chip}</span>
    </li>`;
  }

  function bindPeopleClicks(root) {
    if (!root) return;
    root.querySelectorAll('.nearby-item').forEach((item) => {
      item.addEventListener('click', () => {
        if (item.classList.contains('me-item')) return;
        const id = item.dataset.id;
        const name = item.dataset.name || 'User';
        // Always open 1:1 chat with this username
        connectToUser(id, name);
      });
    });
  }

  function renderNearbyList() {
    prunePeople();
    const myName = (state.name || loadName() || el.nameInput?.value || '').trim();
    if (myName) {
      upsertPerson({
        id: getPresenceId(),
        name: myName,
        room: state.room || '',
        status: state.room ? 'busy' : 'online',
        ts: Date.now()
      });
    }

    // Dedupe by username (keep freshest)
    const byName = new Map();
    for (const p of state.nearbyPeople.values()) {
      const key = p.name.toLowerCase();
      const prev = byName.get(key);
      if (!prev || p.ts > prev.ts) byName.set(key, p);
    }
    const unique = [...byName.values()];

    const people = unique.sort((a, b) => {
      if (a.id === getPresenceId()) return -1;
      if (b.id === getPresenceId()) return 1;
      if (a.name.toLowerCase() === myName.toLowerCase() && a.id === getPresenceId()) return -1;
      return a.name.localeCompare(b.name);
    });

    const others = people.filter((p) => p.id !== getPresenceId() && p.name.toLowerCase() !== myName.toLowerCase());

    if (el.nearbyStatus) {
      el.nearbyStatus.textContent = state.mqttReady
        ? `${others.length} user${others.length === 1 ? '' : 's'} nearby`
        : 'Connecting…';
    }

    if (el.nearbyList) {
      if (!others.length) {
        el.nearbyList.innerHTML = '<li class="nearby-empty">No other users yet.<br/>Friends: open site → register username</li>';
      } else {
        el.nearbyList.innerHTML = others.map((p) => personRowHtml(p, false)).join('');
        bindPeopleClicks(el.nearbyList);
      }
    }

    const homeList = el.homePeopleList || $('#homePeopleList');
    const homeCount = el.homePeopleCount || $('#homePeopleCount');
    if (homeCount) homeCount.textContent = String(others.length);
    if (homeList) {
      if (!myName) {
        homeList.innerHTML = '<li class="nearby-empty">Register username first</li>';
      } else if (!state.mqttReady) {
        homeList.innerHTML = '<li class="nearby-empty">Connecting…</li>';
      } else if (!others.length) {
        homeList.innerHTML = '<li class="nearby-empty">You are online 🟢<br/><br/>Other people register username<br/>then they appear here</li>';
      } else {
        homeList.innerHTML = others.map((p) => personRowHtml(p, false)).join('');
        bindPeopleClicks(homeList);
      }
    }
  }

  function joinRoomCode(room) {
    room = String(room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!room) {
      toast('Enter a valid room code', 'err');
      return;
    }
    el.roomInput.value = room;
    if (el.nearbyRoomInput) el.nearbyRoomInput.value = room;
    closeNearby();
    toast(`Joining ${room}…`, 'ok');
    const name = (el.nameInput.value || loadName() || '').trim();
    if (!name) {
      el.nameInput.focus();
      toast('Type your name, then Enter hive', '');
      return;
    }
    if (state.peer && state.room && state.room !== room) {
      leave();
      setTimeout(() => el.btnJoin.click(), 300);
    } else if (state.room === room) {
      toast('Already in this room', 'ok');
    } else {
      el.btnJoin.click();
    }
  }

  function connectToUser(toId, toName, firstMessage) {
    const myName = (state.name || loadName() || el.nameInput?.value || '').trim();
    if (!myName) {
      showRegister();
      toast('Username register pannunga', 'err');
      return;
    }
    // Deterministic private room between the two users
    const room = pairRoomCode(getPresenceId(), toId);
    if (el.roomInput) el.roomInput.value = room;
    if (el.nameInput) el.nameInput.value = myName;

    const payload = {
      t: 'chat-request',
      to: toId,
      toName: toName || '',
      room,
      fromId: getPresenceId(),
      fromName: myName,
      message: firstMessage || '',
      ts: Date.now()
    };

    // Publish multiple ways so other device always opens
    ensureMqtt(() => {
      try {
        if (toId) {
          state.mqtt.publish(`${PRESENCE_TOPIC}/invite/${toId}`, JSON.stringify(payload), { qos: 0 });
        }
        // by username topic
        const uname = String(toName || '').trim().toLowerCase().replace(/\s+/g, '_').slice(0, 32);
        if (uname) {
          state.mqtt.publish(`${PRESENCE_TOPIC}/user/${uname}`, JSON.stringify(payload), { qos: 0 });
        }
        state.mqtt.publish(PRESENCE_TOPIC, JSON.stringify({ ...payload, t: 'invite-broadcast' }), { qos: 0 });
        // first message relay
        if (firstMessage) {
          state.mqtt.publish(PRESENCE_TOPIC, JSON.stringify({
            t: 'chat-relay',
            fromName: myName,
            fromId: getPresenceId(),
            toName,
            room,
            text: firstMessage,
            ts: Date.now()
          }), { qos: 0 });
        }
      } catch (e) {
        console.warn(e);
      }
    });

    toast(`${toName}-ku chat open…`, 'ok');
    closeNearby();
    state.isGroup = false;
    state.groupName = '';
    state.chatPartnerName = toName;

    const go = () => {
      enterRoom(myName, room);
      // After join, if first message queued
      if (firstMessage) {
        setTimeout(() => {
          if (el.chatInput) {
            el.chatInput.value = firstMessage;
            sendChat();
          }
        }, 1200);
      }
    };

    if (state.peer && state.room === room) {
      toast('Already in chat', 'ok');
      return;
    }
    if (state.peer && state.room && state.room !== room) {
      leave();
      setTimeout(go, 400);
    } else {
      go();
    }
  }

  function invitePerson(toId, toName) {
    connectToUser(toId, toName);
  }

  function showIncomingChat(data) {
    if (!data?.room) return;
    const key = `${data.fromId || ''}|${data.room}|${data.ts || 0}`;
    if (state.seenInviteKeys.has(key)) return;
    state.seenInviteKeys.add(key);
    // keep set small
    if (state.seenInviteKeys.size > 40) {
      state.seenInviteKeys = new Set([...state.seenInviteKeys].slice(-20));
    }

    // Already in that room? ignore
    if (state.room && String(state.room).toUpperCase() === String(data.room).toUpperCase()) {
      return;
    }

    state.pendingInvite = data;
    const who = data.fromName || 'Someone';
    if (el.inviteTitle) el.inviteTitle.textContent = 'Chat request';
    if (el.inviteSub) el.inviteSub.textContent = `${who} wants to chat with you`;
    if (el.inviteMsg) {
      if (data.message) {
        el.inviteMsg.textContent = `"${data.message}"`;
        el.inviteMsg.classList.remove('hidden');
      } else {
        el.inviteMsg.textContent = '';
        el.inviteMsg.classList.add('hidden');
      }
    }
    el.inviteModal?.classList.remove('hidden');
    toast(`${who} chat open panran — Join click pannunga`, 'ok');
    try { navigator.vibrate?.([120, 60, 120, 60, 200]); } catch {}
    // ring tone via WebAudio beep
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880;
      g.gain.value = 0.04;
      o.start();
      setTimeout(() => { try { o.stop(); ctx.close(); } catch {} }, 180);
    } catch {}
  }

  function acceptInvite() {
    const data = state.pendingInvite;
    hideInviteModal();
    if (!data?.room) return;
    const myName = (state.name || loadName() || '').trim();
    if (!myName) {
      showRegister();
      toast('Username register panni malli Join', 'err');
      // keep room for after register
      if (el.roomInput) el.roomInput.value = data.room;
      return;
    }
    if (el.roomInput) el.roomInput.value = data.room;
    if (el.nameInput) el.nameInput.value = myName;
    toast(`${data.fromName || 'Chat'}-oda joining…`, 'ok');
    if (state.peer && state.room && state.room !== data.room) {
      leave();
      setTimeout(() => enterRoom(myName, data.room), 400);
    } else if (state.room === data.room) {
      showRoom();
    } else {
      enterRoom(myName, data.room);
    }
  }

  function declineInvite() {
    const data = state.pendingInvite;
    hideInviteModal();
    if (data?.fromId) {
      ensureMqtt(() => {
        try {
          state.mqtt.publish(PRESENCE_TOPIC, JSON.stringify({
            t: 'invite-declined',
            to: data.fromId,
            fromName: state.name || loadName() || 'User',
            ts: Date.now()
          }), { qos: 0 });
        } catch {}
      });
    }
    state.pendingInvite = null;
    toast('Declined', '');
  }

  function hideInviteModal() {
    el.inviteModal?.classList.add('hidden');
    state.pendingInvite = null;
  }

  function isInviteForMe(data) {
    if (!data) return false;
    const myId = getPresenceId();
    const myName = (state.name || loadName() || '').trim().toLowerCase();
    if (data.to && data.to === myId) return true;
    if (data.toName && myName) {
      const t = String(data.toName).trim().toLowerCase();
      if (t === myName || myName.includes(t) || t.includes(myName)) return true;
    }
    return false;
  }

  function presencePayload() {
    const name = (state.name || el.nameInput?.value || '').trim().slice(0, 24);
    if (!name) return null;
    const room = sanitizeRoom(state.room);
    // self-heal corrupt room stuck in state
    if (state.room && !room) state.room = '';
    return {
      t: 'presence',
      id: getPresenceId(),
      name,
      room: room || '',
      status: room ? 'room' : 'online',
      ts: Date.now()
    };
  }

  function publishPresence(force) {
    const payload = presencePayload();
    if (!payload) {
      updatePresenceHint();
      return;
    }
    // Local self immediately (list filter still hides self)
    upsertPerson(payload);
    renderNearbyList();
    updatePresenceHint();

    ensureMqtt(() => {
      if (!state.mqtt || !state.mqttReady) return;
      try {
        // qos 0 fire-and-forget; publish twice for flaky mobile nets
        const raw = JSON.stringify(payload);
        state.mqtt.publish(PRESENCE_TOPIC, raw, { qos: 0 });
        setTimeout(() => {
          try { if (state.mqttReady) state.mqtt.publish(PRESENCE_TOPIC, raw, { qos: 0 }); } catch {}
        }, 400);
      } catch (e) {
        console.warn('publish presence', e);
      }
    });
  }

  function askWhoIsOnline() {
    ensureMqtt(() => {
      if (!state.mqtt || !state.mqttReady) return;
      try {
        state.mqtt.publish(PRESENCE_TOPIC, JSON.stringify({
          t: 'who',
          fromId: getPresenceId(),
          ts: Date.now()
        }), { qos: 0 });
      } catch {}
    });
  }

  function startPresenceLoop() {
    if (state.presenceTimer) return;
    // Fast heartbeat — nearby feels live
    state.presenceTimer = setInterval(() => {
      publishPresence();
      prunePeople();
      renderNearbyList();
    }, 3000);
    // periodic who scan
    setInterval(() => {
      if (state.mqttReady) askWhoIsOnline();
    }, 8000);
  }

  function stopPresenceLoop() {
    if (state.presenceTimer) {
      clearInterval(state.presenceTimer);
      state.presenceTimer = null;
    }
  }

  function updatePresenceHint() {
    const hint = el.presenceHint || $('#presenceHint');
    if (!hint) return;
    const name = (state.name || loadName() || el.nameInput?.value || '').trim();
    if (!name) {
      hint.textContent = 'Offline';
      hint.classList.add('off');
      return;
    }
    if (state.mqttReady) {
      const n = [...state.nearbyPeople.values()].filter(
        (p) => p.id !== getPresenceId() && p.name.toLowerCase() !== name.toLowerCase()
      ).length;
      hint.textContent = n ? `Online · ${n} nearby` : 'Online · scanning…';
      hint.classList.remove('off');
    } else {
      hint.textContent = 'Connecting nearby…';
      hint.classList.add('off');
    }
  }

  let mqttBooting = false;
  const mqttWaiters = [];

  function ensureMqtt(cb) {
    if (typeof cb === 'function') mqttWaiters.push(cb);

    const flushWaiters = () => {
      while (mqttWaiters.length) {
        try { mqttWaiters.shift()(); } catch (e) { console.warn(e); }
      }
    };

    if (state.mqtt && state.mqttReady) {
      flushWaiters();
      return;
    }
    if (mqttBooting) return;
    mqttBooting = true;

    const startConnect = (M) => {
      if (!M || typeof M.connect !== 'function') {
        mqttBooting = false;
        if (el.nearbyStatus) el.nearbyStatus.textContent = 'Nearby offline — refresh page';
        toast('Nearby connect fail — internet / refresh', 'err');
        updatePresenceHint();
        // retry load later
        setTimeout(() => { mqttBooting = false; ensureMqtt(); }, 5000);
        return;
      }

      const pid = getPresenceId();
      let urlIndex = 0;

      const connectNext = () => {
        if (urlIndex >= MQTT_URLS.length) {
          state.mqttReady = false;
          mqttBooting = false;
          if (el.nearbyStatus) el.nearbyStatus.textContent = 'Nearby offline — tap Refresh';
          updatePresenceHint();
          setTimeout(() => ensureMqtt(), 4000);
          return;
        }
        const url = MQTT_URLS[urlIndex++];
        try {
          if (state.mqtt) {
            try { state.mqtt.removeAllListeners?.(); state.mqtt.end(true); } catch {}
            state.mqtt = null;
          }
          const client = M.connect(url, {
            clientId: 'qrtrx_' + String(pid).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + '_' + Math.random().toString(16).slice(2, 6),
            clean: true,
            connectTimeout: 12000,
            reconnectPeriod: 0, // we handle reconnect
            keepalive: 15,
            protocolVersion: 4
          });
          state.mqtt = client;
          let settled = false;

          const ok = () => {
            if (settled) return;
            settled = true;
            mqttBooting = false;
            state.mqttReady = true;
            if (el.nearbyStatus) el.nearbyStatus.textContent = 'Nearby online';
            try {
              client.subscribe(PRESENCE_TOPIC, { qos: 0 });
              client.subscribe(PRESENCE_TOPIC + '/invite/' + pid, { qos: 0 });
              const uname = String(state.name || loadName() || '')
                .trim().toLowerCase().replace(/\s+/g, '_').slice(0, 32);
              if (uname) client.subscribe(PRESENCE_TOPIC + '/user/' + uname, { qos: 0 });
            } catch (e) { console.warn(e); }

            // Announce + ask who is online + keep ALL groups connected
            publishPresence(true);
            setTimeout(askWhoIsOnline, 300);
            setTimeout(publishPresence, 800);
            setTimeout(subscribeAllGroups, 200);
            startPresenceLoop();
            updatePresenceHint();
            renderNearbyList();
            renderGroupList();
            flushWaiters();
          };

          client.on('connect', ok);
          // some brokers fire 'connect' late — also listen packetconnect
          client.on('packetreceive', () => {});

          client.on('message', (topic, buf) => {
            let data;
            try {
              data = JSON.parse(typeof buf === 'string' ? buf : buf.toString('utf8'));
            } catch { return; }
            onMqttMessage(topic, data);
          });

          client.on('error', (err) => {
            console.warn('mqtt error', url, err?.message || err);
          });

          client.on('close', () => {
            if (state.mqtt === client) {
              state.mqttReady = false;
              updatePresenceHint();
            }
          });

          client.on('offline', () => {
            if (state.mqtt === client) state.mqttReady = false;
          });

          setTimeout(() => {
            if (!settled) {
              try { client.end(true); } catch {}
              if (state.mqtt === client) state.mqtt = null;
              connectNext();
            }
          }, 11000);
        } catch (e) {
          console.warn(e);
          connectNext();
        }
      };

      connectNext();
    };

    // Ensure library then connect
    const M0 = getMqttLib();
    if (M0) {
      startConnect(M0);
    } else {
      loadMqttScript().then((M) => startConnect(M));
    }
  }

  function onMqttMessage(topic, data) {
    if (!data || typeof data !== 'object') return;

    // Discovery: someone asked who is online → reply with presence
    if (data.t === 'who') {
      if (data.fromId !== getPresenceId()) {
        // small random delay so not all reply same ms
        setTimeout(() => publishPresence(true), 50 + Math.random() * 400);
      }
      return;
    }

    if (data.t === 'presence' && data.id) {
      // Don't drop for clock skew — we use local receive time in upsertPerson
      upsertPerson(data);
      renderNearbyList();
      updatePresenceHint();
      return;
    }

    // Chat request / invite → open Join popup for receiver
    if (
      (data.t === 'chat-request' || data.t === 'invite' || data.t === 'invite-broadcast') &&
      data.room &&
      data.fromId !== getPresenceId() &&
      isInviteForMe(data)
    ) {
      showIncomingChat(data);
      return;
    }

    if (data.t === 'invite-declined' && data.to === getPresenceId()) {
      toast(`${data.fromName || 'User'} declined chat`, 'err');
      return;
    }

    // Message delivery / seen ticks
    if (data.t === 'msg-ack' && data.mid) {
      if (!data.to || data.to === getPresenceId()) {
        updateMsgTicks(data.mid, data.kind === 'seen' ? 'seen' : 'delivered');
      }
      return;
    }

    // Group channel — active chat OR always-subscribed groups
    if (data.room) {
      const roomCode = sanitizeRoom(data.room);
      const inThisChat = state.room && sanitizeRoom(state.room) === roomCode;
      const alwaysOn = roomCode && state.subscribedGroups.has(roomCode);

      if (inThisChat || alwaysOn) {
        if (data.t === 'gjoin' && data.fromId !== getPresenceId()) {
          if (inThisChat) addSystem(`${data.fromName || 'Someone'} joined`);
          return;
        }
        if (data.t === 'gpresence' && data.fromId !== getPresenceId()) {
          return;
        }
        if (data.t === 'gchat' && data.fromId !== getPresenceId()) {
          if (inThisChat) {
            const d = addChat({
              name: data.fromName || 'Member',
              text: data.text,
              me: false,
              mid: data.mid
            });
            if (d && data.fromId) d.dataset.fromId = data.fromId;
            sendDeliveryAck(data.mid, data.fromId, 'delivered');
            if (document.visibilityState === 'visible') {
              setTimeout(() => sendDeliveryAck(data.mid, data.fromId, 'seen'), 200);
            }
          } else {
            toast(`${data.fromName} · ${String(data.text || '').slice(0, 40)}`, 'ok');
            playMsgSound();
          }
          return;
        }

        if (data.t === 'gfile-batch' && data.fromId !== getPresenceId()) {
          if (inThisChat) addSystem(`${data.fromName || 'Someone'} sharing ${data.count || '?'} file(s)…`);
          toast(`${data.fromName}: ${data.count} files incoming`, 'ok');
          return;
        }
        if (data.t === 'gfile-meta' && data.fromId !== getPresenceId()) {
          handleGFileMeta(data);
          return;
        }
        if (data.t === 'gfile-chunk' && data.fromId !== getPresenceId()) {
          handleGFileChunk(data);
          return;
        }
        if (data.t === 'gfile-end' && data.fromId !== getPresenceId()) {
          handleGFileEnd(data, inThisChat);
          return;
        }
      }
    }

    if (data.t && String(data.t).startsWith('g') && data.room) {
      return;
    }

    if (data.t === 'group-announce' && data.code) {
      // optional: could show public groups — skip auto-join
      return;
    }

    // MQTT chat relay
    if (data.t === 'chat-relay' && data.text) {
      const myName = (state.name || loadName() || el.nameInput?.value || '').trim().toLowerCase();
      const to = String(data.toName || '').trim().toLowerCase();
      const from = String(data.fromName || 'Someone');
      const sameRoom = !!(state.room && data.room && String(state.room).toUpperCase() === String(data.room).toUpperCase());
      const toMe = !!(to && myName && (myName === to || myName.includes(to) || to.includes(myName)));
      if (data.fromId && data.fromId === getPresenceId()) return;

      if (sameRoom) {
        if (el.viewRoom?.classList.contains('active')) {
          const d = addChat({
            name: from,
            text: String(data.text).slice(0, 4000),
            me: false,
            mid: data.mid
          });
          if (d && data.fromId) d.dataset.fromId = data.fromId;
          sendDeliveryAck(data.mid, data.fromId, 'delivered');
          if (document.visibilityState === 'visible') {
            setTimeout(() => sendDeliveryAck(data.mid, data.fromId, 'seen'), 200);
          }
        }
        return;
      }

      if (toMe && data.room) {
        showIncomingChat({
          t: 'chat-request',
          fromId: data.fromId,
          fromName: from,
          toName: data.toName,
          room: data.room,
          message: data.text,
          ts: data.ts || Date.now()
        });
      } else if (toMe) {
        toast(`${from}: ${String(data.text).slice(0, 100)}`, 'ok');
      }
    }
  }

  function onNameTyped() {
    const name = (el.nameInput.value || '').trim();
    saveName(name);
    clearTimeout(state.nameDebounce);
    state.nameDebounce = setTimeout(() => {
      if (name.length >= 1) {
        state.name = name;
        ensureMqtt();
        publishPresence(true);
        startPresenceLoop();
        updatePresenceHint();
      } else {
        updatePresenceHint();
      }
    }, 400);
  }

  // keep old names used by room join flow
  function startAnnouncing() {
    publishPresence(true);
    startPresenceLoop();
  }
  function stopAnnouncing() {
    // presence continues with online status after leave
    publishPresence(true);
  }
  function startNearbyClient() {
    ensureMqtt();
    publishPresence(true);
  }

  // ── Camera + jsQR ──────────────────────────────────────
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      if (el.camStatus) el.camStatus.textContent = 'Camera not supported — upload QR photo or type code';
      toast('Camera not supported on this browser', 'err');
      return;
    }
    if (!window.jsQR) {
      if (el.camStatus) el.camStatus.textContent = 'Scanner loading failed — upload QR photo';
      toast('jsQR missing — check internet / refresh', 'err');
      return;
    }

    await stopCamera();
    state.scanLock = false;
    if (el.camStatus) el.camStatus.textContent = 'Starting camera…';
    el.btnStartCam?.classList.add('hidden');
    el.btnStopCam?.classList.remove('hidden');

    const tryConstraints = [
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
      { audio: false, video: { facingMode: 'environment' } },
      { audio: false, video: { facingMode: 'user' } },
      { audio: false, video: true }
    ];

    let stream = null;
    let lastErr = null;
    for (const c of tryConstraints) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!stream) {
      console.warn(lastErr);
      if (el.camStatus) el.camStatus.textContent = 'Camera blocked — allow permission or upload QR photo';
      toast('Allow camera permission', 'err');
      el.btnStartCam?.classList.remove('hidden');
      el.btnStopCam?.classList.add('hidden');
      return;
    }

    state.camStream = stream;
    const video = el.camVideo;
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    try { await video.play(); } catch (e) { console.warn(e); }

    el.camOverlay?.classList.add('on');
    if (el.camStatus) el.camStatus.textContent = 'Point at host QR code…';

    const canvas = el.camCanvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      if (!state.camStream) return;
      if (video.readyState >= 2) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w && h) {
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
          if (code?.data) {
            onQrDecoded(code.data);
            return;
          }
        }
      }
      state.camRaf = requestAnimationFrame(tick);
    };
    state.camRaf = requestAnimationFrame(tick);
  }

  async function stopCamera() {
    if (state.camRaf) {
      cancelAnimationFrame(state.camRaf);
      state.camRaf = 0;
    }
    if (state.camStream) {
      try { state.camStream.getTracks().forEach((t) => t.stop()); } catch {}
      state.camStream = null;
    }
    if (el.camVideo) {
      try { el.camVideo.pause(); } catch {}
      el.camVideo.srcObject = null;
    }
    el.camOverlay?.classList.remove('on');
    el.btnStartCam?.classList.remove('hidden');
    el.btnStopCam?.classList.add('hidden');
    if (el.camStatus && !state.scanLock) el.camStatus.textContent = 'Camera off · Start camera or upload QR photo';
  }

  function onQrDecoded(text) {
    if (state.scanLock) return;
    if (!text) return;

    let room = '';
    const raw = String(text).trim();
    try {
      if (/^https?:\/\//i.test(raw) || raw.includes('room=')) {
        const u = new URL(raw, location.href);
        room = (u.searchParams.get('room') || '').toUpperCase();
      }
    } catch {
      /* fall through */
    }
    if (!room) {
      const m = raw.match(/room=([A-Za-z0-9]{4,8})/i);
      if (m) room = m[1].toUpperCase();
    }
    if (!room && /^[A-Z0-9]{4,8}$/i.test(raw)) {
      room = raw.toUpperCase();
    }

    if (!room) {
      if (el.camStatus) el.camStatus.textContent = 'QR read, but not a room link — try again';
      return;
    }

    state.scanLock = true;
    if (el.camStatus) el.camStatus.textContent = `Found room ${room}`;
    toast(`QR OK · ${room}`, 'ok');
    stopCamera();
    joinRoomCode(room);
  }

  function scanImageFile(file) {
    if (!file || !window.jsQR) {
      toast('Cannot scan image', 'err');
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
      URL.revokeObjectURL(url);
      if (code?.data) onQrDecoded(code.data);
      else toast('No QR found in photo', 'err');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('Could not read image', 'err');
    };
    img.src = url;
  }

  // ── Events ─────────────────────────────────────────────
  function addFiles(list) {
    if (state.batchSending) {
      toast('Wait — files still sharing…', 'ok');
      return;
    }
    const incoming = [...list];
    if (!incoming.length) return;

    let added = 0;
    for (const f of incoming) {
      if (state.pendingFiles.length >= MAX_BATCH_FILES) break;
      if (state.pendingFiles.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) continue;
      state.pendingFiles.push(f);
      added += 1;
    }
    if (incoming.length > added) {
      toast(`Max ${MAX_BATCH_FILES} files — ${added} queued`, 'ok');
    }

    renderQueue();

    if (state.pendingFiles.length && state.room) {
      const snapshot = [...state.pendingFiles];
      state.pendingFiles = [];
      renderQueue();
      const n = snapshot.length;
      toast(n === 1 ? 'Sharing 1 file…' : `Sharing ${n} files to group…`, 'ok');
      sendFilesInRoom(snapshot).catch((e) => {
        console.warn(e);
        state.batchSending = false;
        toast('File share failed — retry', 'err');
      });
    } else if (state.pendingFiles.length && !state.room) {
      toast('Open group/chat first, then attach files', 'err');
      state.pendingFiles = [];
      renderQueue();
    }
  }

  function bind() {
    const saved = loadName();
    if (el.nameInput) el.nameInput.value = saved;
    if (el.regNameInput) el.regNameInput.value = saved;
    if (el.roomInput) el.roomInput.value = roomFromUrl() || '';

    el.btnRegister?.addEventListener('click', () => {
      registerUsername(el.regNameInput?.value);
    });
    el.regNameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') registerUsername(el.regNameInput.value);
    });
    el.btnLogout?.addEventListener('click', () => {
      try { localStorage.removeItem('hivedrop_name'); } catch {}
      state.name = '';
      stopPresenceLoop();
      showRegister();
    });
    el.btnRefreshHome?.addEventListener('click', () => {
      if (!state.mqttReady) {
        mqttBooting = false;
        try { state.mqtt?.end?.(true); } catch {}
        state.mqtt = null;
        ensureMqtt();
      }
      publishPresence(true);
      askWhoIsOnline();
      setTimeout(() => {
        prunePeople();
        renderNearbyList();
        updatePresenceHint();
      }, 600);
      toast(state.mqttReady ? 'Scanning nearby…' : 'Reconnecting…', 'ok');
    });

    el.btnInviteAccept?.addEventListener('click', acceptInvite);
    el.btnInviteDecline?.addEventListener('click', declineInvite);

    // Home tabs: Share / Users / Groups
    $$('[data-home-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('[data-home-tab]').forEach((t) => t.classList.toggle('active', t === tab));
        const name = tab.getAttribute('data-home-tab');
        $('#paneShare')?.classList.toggle('active', name === 'share');
        $('#paneUsers')?.classList.toggle('active', name === 'users');
        $('#paneGroups')?.classList.toggle('active', name === 'groups');
        if (name === 'groups') renderGroupList();
        if (name === 'share') renderHomeShareQr();
        if (name === 'users') {
          publishPresence(true);
          askWhoIsOnline();
          renderNearbyList();
        }
      });
    });

    $('#btnCopyShare')?.addEventListener('click', async () => {
      const url = shareUrl(getPersonalCode());
      try {
        await navigator.clipboard.writeText(url);
        toast('Share link copied', 'ok');
      } catch {
        toast(url, 'ok');
      }
    });
    $('#btnOpenShareChat')?.addEventListener('click', () => {
      const myName = state.name || loadName();
      if (!myName) return showRegister();
      state.isGroup = false;
      state.groupName = '';
      state.chatPartnerName = '';
      enterRoom(myName, getPersonalCode());
    });
    $('#btnScanToJoin')?.addEventListener('click', () => {
      openNearby();
      switchNearbyTab('camera');
    });

    $('#btnCreateGroup')?.addEventListener('click', () => {
      $('#createGroupModal')?.classList.remove('hidden');
      $('#newGroupName')?.focus();
    });
    $('#btnJoinGroup')?.addEventListener('click', () => {
      $('#joinGroupModal')?.classList.remove('hidden');
      $('#joinGroupCode')?.focus();
    });
    $$('[data-close-cg]').forEach((n) => n.addEventListener('click', () => $('#createGroupModal')?.classList.add('hidden')));
    $$('[data-close-jg]').forEach((n) => n.addEventListener('click', () => $('#joinGroupModal')?.classList.add('hidden')));
    $('#btnDoCreateGroup')?.addEventListener('click', () => {
      const name = $('#newGroupName')?.value || '';
      $('#createGroupModal')?.classList.add('hidden');
      createGroup(name);
    });
    $('#btnDoJoinGroup')?.addEventListener('click', () => {
      const code = $('#joinGroupCode')?.value || '';
      const name = $('#joinGroupName')?.value || '';
      $('#joinGroupModal')?.classList.add('hidden');
      joinGroupByCode(code, name);
    });
    $('#btnMembers')?.addEventListener('click', () => {
      $('#membersDrawer')?.classList.add('open');
    });
    $('#btnCloseMembers')?.addEventListener('click', () => {
      $('#membersDrawer')?.classList.remove('open');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') markVisibleMessagesSeen();
    });

    el.btnRandomRoom?.addEventListener('click', () => {
      el.roomInput.value = randomRoom();
      el.roomInput.focus();
    });

    el.btnJoin?.addEventListener('click', () => {
      const name = (el.nameInput?.value || state.name || loadName() || 'Guest').trim().slice(0, 24);
      let room = (el.roomInput?.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!room) room = randomRoom();
      if (el.roomInput) el.roomInput.value = room;
      if (!window.Peer) {
        toast('PeerJS failed to load — check internet', 'err');
        return;
      }
      state.name = name;
      saveName(name);
      enterRoom(name, room);
    });

    // Keep advanced name field in sync
    el.nameInput?.addEventListener('input', onNameTyped);
    el.nameInput?.addEventListener('change', onNameTyped);
    el.nameInput?.addEventListener('blur', onNameTyped);
    el.nameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.btnJoin?.click();
    });
    el.roomInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.btnJoin?.click(); });

    el.btnLeave?.addEventListener('click', leave);
    el.btnQr.addEventListener('click', openQr);
    el.btnCopy.addEventListener('click', copyLink);
    el.btnCopyModal.addEventListener('click', copyLink);
    el.qrModal.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', closeQr));

    el.btnNearby?.addEventListener('click', openNearby);
    el.btnNearbyInRoom?.addEventListener('click', openNearby);
    el.nearbyModal?.querySelectorAll('[data-close-nearby]').forEach((n) => {
      n.addEventListener('click', closeNearby);
    });
    $$('.nearby-tabs .tab').forEach((t) => {
      t.addEventListener('click', () => switchNearbyTab(t.dataset.tab));
    });
    el.btnStartCam?.addEventListener('click', () => startCamera());
    el.btnStopCam?.addEventListener('click', () => stopCamera());
    el.qrFileInput?.addEventListener('change', () => {
      const f = el.qrFileInput.files?.[0];
      if (f) scanImageFile(f);
      el.qrFileInput.value = '';
    });
    el.btnNearbyJoinCode?.addEventListener('click', () => {
      joinRoomCode(el.nearbyRoomInput?.value || el.roomInput.value);
    });
    el.nearbyRoomInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinRoomCode(el.nearbyRoomInput.value);
    });
    el.btnRefreshNearby?.addEventListener('click', () => {
      if (el.nearbyStatus) el.nearbyStatus.textContent = 'Refreshing…';
      publishPresence(true);
      prunePeople();
      renderNearbyList();
      toast('List refreshed', 'ok');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeQr();
        closeNearby();
      }
    });

    el.btnSendChat.addEventListener('click', sendChat);
    el.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });

    el.dropZone.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => {
      addFiles(el.fileInput.files);
      el.fileInput.value = '';
    });
    ['dragenter', 'dragover'].forEach((ev) => {
      el.dropZone.addEventListener(ev, (e) => { e.preventDefault(); el.dropZone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      el.dropZone.addEventListener(ev, (e) => { e.preventDefault(); el.dropZone.classList.remove('drag'); });
    });
    el.dropZone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

    el.btnSendFiles.addEventListener('click', async () => {
      el.btnSendFiles.disabled = true;
      try {
        if (state.room) {
          await sendFilesInRoom();
        } else {
          const targets = [...state.peers.keys()].filter((id) => id !== state.id && state.conns.has(id));
          await sendFilesTo(targets);
        }
      } finally {
        renderQueue();
      }
    });

    document.addEventListener('paste', (e) => {
      if (!el.viewRoom.classList.contains('active')) return;
      if (e.clipboardData?.files?.length) addFiles(e.clipboardData.files);
    });
  }

  // Boot: register once → home nearby users
  bind();
  const bootName = loadName();
  loadGroups();
  if (bootName) {
    state.name = bootName;
    showJoin();
    renderGroupList();
    setTimeout(() => {
      ensureMqtt(() => {
        subscribeAllGroups();
        publishPresence(true);
        startPresenceLoop();
        updatePresenceHint();
        renderGroupList();
      });
    }, 200);
  } else {
    showRegister();
  }

  // Deep link / QR scan: ?room=CODE&share=1&from=Name
  const bootRoom = roomFromUrl();
  const params = new URLSearchParams(location.search);
  if (bootRoom && bootName) {
    if (el.roomInput) el.roomInput.value = bootRoom;
    if (params.get('group') === '1') {
      state.isGroup = true;
      state.groupName = params.get('gname') || bootRoom;
      setTimeout(() => openGroup(bootRoom, state.groupName), 400);
    } else {
      // Quick Share join — stable MQTT chat
      const from = params.get('from') || '';
      if (from) state.chatPartnerName = from;
      state.isGroup = false;
      setTimeout(() => enterRoom(bootName, bootRoom), 400);
    }
  } else if (bootRoom && !bootName) {
    // Need register first, keep room
    if (el.roomInput) el.roomInput.value = bootRoom;
    if (el.regNameInput) el.regNameInput.placeholder = 'Enter username to join chat';
    toast('Username type panni Continue — then chat open aagum', 'ok');
  } else if (bootRoom && el.roomInput) {
    el.roomInput.value = bootRoom;
  }
})();

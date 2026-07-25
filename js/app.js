/**
 * HiveDrop — GitHub Pages friendly LAN chat + file share
 * PeerJS free cloud for signaling · WebRTC DataChannels for P2P (LAN preferred)
 */
(() => {
  'use strict';

  const CHUNK = 16 * 1024; // 16 KB
  const MAX_FILE = 200 * 1024 * 1024; // 200 MB soft cap per file
  const PEER_PREFIX = 'hivedrop-';
  const NEARBY_TTL_MS = 45_000;
  const PRESENCE_TOPIC = 'qrtrx/v1/presence';
  const MQTT_URLS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];

  function getMqttLib() {
    return window.mqtt || globalThis.mqtt || null;
  }

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const el = {
    viewJoin: $('#view-join'),
    viewRoom: $('#view-room'),
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
  };

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

  function roomFromUrl() {
    const p = new URLSearchParams(location.search);
    return (p.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
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
  function showJoin() {
    el.viewJoin.classList.add('active');
    el.viewRoom.classList.remove('active');
  }
  function showRoom() {
    el.viewJoin.classList.remove('active');
    el.viewRoom.classList.add('active');
  }

  function addSystem(text) {
    const d = document.createElement('div');
    d.className = 'msg system';
    d.textContent = text;
    el.chatLog.appendChild(d);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function addChat({ name, text, me, file }) {
    const d = document.createElement('div');
    d.className = `msg ${me ? 'me' : 'them'}${file ? ' file-msg' : ''}`;
    if (file) {
      d.innerHTML = `
        <span class="who">${escapeHtml(name)}</span>
        📎 <a href="${file.url}" download="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a>
        <span style="color:var(--dim);font-size:0.75rem"> (${fmtBytes(file.size)})</span>
        <span class="time">${timeNow()}</span>`;
    } else {
      d.innerHTML = `
        <span class="who">${escapeHtml(name)}</span>
        ${escapeHtml(text)}
        <span class="time">${timeNow()}</span>`;
    }
    el.chatLog.appendChild(d);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
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
    el.btnSendFiles.disabled = state.pendingFiles.length === 0 || state.peers.size < 2;
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
        addChat({ name: data.name || 'Guest', text: data.text, me: false });
        try { navigator.vibrate?.(40); } catch {}
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
        addChat({
          name: rec.fromName,
          me: false,
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

  async function sendFilesTo(targets) {
    const files = [...state.pendingFiles];
    if (!files.length || !targets.length) return;

    for (const file of files) {
      if (file.size > MAX_FILE) {
        toast(`${file.name} too large (max ~200MB)`, 'err');
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
        fromId: state.id
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
    const payload = { t: 'chat', name: state.name, text, id: state.id };
    broadcast(payload);
    addChat({ name: state.name, text, me: true });
    el.chatInput.value = '';
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

  function enterRoom(name, room) {
    destroyPeer();
    state.name = name;
    state.room = room;
    saveName(name);
    publishPresence(true);

    el.btnJoin.disabled = true;
    el.btnJoin.textContent = 'Connecting…';
    setStatus('warn');

    const hid = hostPeerId(room);
    state.hostId = hid;

    // Try become host first
    const hostPeer = new Peer(hid, peerConfig());

    let settled = false;

    const failHostBecomeClient = () => {
      if (settled) return;
      try { hostPeer.destroy(); } catch {}
      becomeClient(name, room, hid);
    };

    hostPeer.on('open', (id) => {
      if (settled) return;
      settled = true;
      // We are host
      state.peer = hostPeer;
      state.id = id;
      state.isHost = true;
      state.peers.set(id, { id, name, isHost: true });
      onJoined();
    });

    hostPeer.on('connection', (conn) => {
      wireConn(conn);
      // track placeholder until hello
      state.peers.set(conn.peer, { id: conn.peer, name: '…', isHost: false });
      renderPeers();
    });

    hostPeer.on('error', (err) => {
      console.warn('host peer error', err?.type || err);
      // Room already has a host → join as client
      if (err?.type === 'unavailable-id') {
        failHostBecomeClient();
        return;
      }
      if (!settled && (err?.type === 'network' || err?.type === 'server-error')) {
        toast('Cannot reach PeerJS — check internet', 'err');
        el.btnJoin.disabled = false;
        el.btnJoin.innerHTML = 'Enter hive <span>→</span>';
        setStatus('');
        try { hostPeer.destroy(); } catch {}
      }
    });

    // Safety: if host id never opens (rare), try client path
    setTimeout(() => {
      if (!settled) failHostBecomeClient();
    }, 5000);
  }

  function becomeClient(name, room, hid) {
    const client = new Peer(peerConfig());

    state.peer = client;
    state.isHost = false;
    state.hostId = hid;
    let joined = false;
    let tries = 0;

    const finishJoin = () => {
      if (joined) return;
      joined = true;
      onJoined();
    };

    const tryConnectHost = () => {
      tries += 1;
      try {
        const conn = client.connect(hid, { reliable: true });
        wireConn(conn);
        conn.on('open', () => {
          // ensure peer in list
          if (!state.peers.has(hid)) {
            state.peers.set(hid, { id: hid, name: 'Host', isHost: true });
            renderPeers();
          }
          finishJoin();
        });
        // if not open in 4s, retry or takeover
        setTimeout(() => {
          if (joined) return;
          if (tries < 3) {
            tryConnectHost();
          } else {
            // Host ghost — become host ourselves
            toast('Host offline — you are host now', 'ok');
            try { client.destroy(); } catch {}
            state.peer = null;
            // re-enter as host claim
            const hostPeer = new Peer(hid, peerConfig());
            hostPeer.on('open', (id) => {
              state.peer = hostPeer;
              state.id = id;
              state.isHost = true;
              state.peers.set(id, { id, name, isHost: true });
              hostPeer.on('connection', (c) => {
                wireConn(c);
                state.peers.set(c.peer, { id: c.peer, name: '…', isHost: false });
                renderPeers();
              });
              finishJoin();
            });
            hostPeer.on('error', (err) => {
              if (err?.type === 'unavailable-id') {
                // someone took it — try client again
                setTimeout(() => becomeClient(name, room, hid), 800);
              } else {
                toast('Could not join room — try again', 'err');
                el.btnJoin.disabled = false;
                el.btnJoin.innerHTML = 'Enter hive <span>→</span>';
                destroyPeer();
                showJoin();
              }
            });
          }
        }, 4000);
      } catch (e) {
        console.warn(e);
      }
    };

    client.on('open', (id) => {
      state.id = id;
      state.peers.set(id, { id, name, isHost: false });
      tryConnectHost();
    });

    client.on('connection', (conn) => {
      wireConn(conn);
    });

    client.on('error', (err) => {
      console.warn('client error', err);
      if (err?.type === 'peer-unavailable') {
        // handled by retry / takeover timer
      } else if (err?.type === 'network') {
        toast('Network error — need internet', 'err');
      }
    });
  }

  function onJoined() {
    el.btnJoin.disabled = false;
    el.btnJoin.innerHTML = 'Enter hive <span>→</span>';
    el.roomBadge.textContent = state.room;
    el.roleBadge.textContent = state.isHost ? 'HOST' : 'JOINED';
    showRoom();
    renderPeers();
    renderQueue();
    el.chatLog.innerHTML = '';
    addSystem(state.isHost
      ? `Room ${state.room} created · show QR so others can join`
      : `Joined room ${state.room}`);
    setStatus('on');
    toast(state.isHost ? 'You are host' : 'Connected', 'ok');

    // URL
    const u = new URL(location.href);
    u.searchParams.set('room', state.room);
    history.replaceState(null, '', u);

    // Show QR for host; everyone helps advertise room to nearby list
    if (state.isHost) {
      setTimeout(() => openQr(), 400);
    }
    startAnnouncing();
  }

  // ── QR (reliable multi-fallback) ───────────────────────
  function openQr() {
    const url = joinUrl();
    el.joinUrl.textContent = url;
    if (el.qrRoomBig) el.qrRoomBig.textContent = state.room || '';
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
    destroyPeer();
    state.room = '';
    state.isHost = false;
    publishPresence(true);
    const u = new URL(location.href);
    u.searchParams.delete('room');
    history.replaceState(null, '', u.pathname + u.hash);
    showJoin();
    toast('Left room');
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
    const name = String(p.name).trim().slice(0, 24);
    if (!name) return;
    const room = p.room
      ? String(p.room).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
      : '';
    state.nearbyPeople.set(p.id, {
      id: p.id,
      name,
      room,
      status: room ? 'room' : (p.status || 'online'),
      ts: p.ts || Date.now()
    });
  }

  function personRowHtml(p, me) {
    const age = Math.max(0, Math.round((Date.now() - p.ts) / 1000));
    const st = p.room
      ? `<span class="st-room">Room ${escapeHtml(p.room)}</span>`
      : `<span class="st-online">Online</span>`;
    const chip = me ? 'You' : (p.room ? 'Join →' : 'Invite');
    return `<li class="nearby-item${me ? ' me-item' : ''}" data-id="${escapeHtml(p.id)}" data-room="${escapeHtml(p.room || '')}" data-name="${escapeHtml(p.name)}">
      <div class="av">${escapeHtml(initials(p.name))}</div>
      <div class="meta">
        <div class="nm">${escapeHtml(p.name)}${me ? ' (you)' : ''}</div>
        <div class="rm">${st} · ${age}s</div>
      </div>
      <span class="join-chip">${chip}</span>
    </li>`;
  }

  function bindPeopleClicks(root) {
    if (!root) return;
    root.querySelectorAll('.nearby-item').forEach((item) => {
      item.addEventListener('click', () => {
        if (item.classList.contains('me-item')) return;
        const room = item.dataset.room;
        const id = item.dataset.id;
        const name = item.dataset.name || 'User';
        if (room) joinRoomCode(room);
        else invitePerson(id, name);
      });
    });
  }

  function renderNearbyList() {
    prunePeople();
    const myName = (state.name || el.nameInput?.value || '').trim();
    if (myName) {
      upsertPerson({
        id: getPresenceId(),
        name: myName,
        room: state.room || '',
        status: state.room ? 'room' : 'online',
        ts: Date.now()
      });
    }

    const people = [...state.nearbyPeople.values()].sort((a, b) => {
      if (a.id === getPresenceId()) return -1;
      if (b.id === getPresenceId()) return 1;
      if (a.room && !b.room) return -1;
      if (!a.room && b.room) return 1;
      return a.name.localeCompare(b.name);
    });

    const others = people.filter((p) => p.id !== getPresenceId());
    if (el.nearbyStatus) {
      el.nearbyStatus.textContent = state.mqttReady
        ? `${people.length} online · ${others.length} other`
        : 'Connecting presence…';
    }

    if (el.nearbyList) {
      if (!people.length) {
        el.nearbyList.innerHTML = '<li class="nearby-empty">No one yet.<br/>Both devices: open site → type name → wait 2 sec</li>';
      } else {
        el.nearbyList.innerHTML = people.map((p) => personRowHtml(p, p.id === getPresenceId())).join('');
        bindPeopleClicks(el.nearbyList);
      }
    }

    const homeList = $('#homePeopleList');
    const homeCount = $('#homePeopleCount');
    if (homeCount) homeCount.textContent = String(others.length);
    if (homeList) {
      if (!myName) {
        homeList.innerHTML = '<li class="nearby-empty">Type your name to see people…</li>';
      } else if (!others.length) {
        homeList.innerHTML = state.mqttReady
          ? '<li class="nearby-empty">You are online. Waiting for others…</li>'
          : '<li class="nearby-empty">Connecting…</li>';
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

  function invitePerson(toId, toName) {
    const myName = (el.nameInput.value || state.name || loadName() || '').trim();
    if (!myName) {
      toast('Type your name first', 'err');
      el.nameInput?.focus();
      return;
    }
    // Create / use a room then invite them
    let room = (el.roomInput.value || state.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!room) room = randomRoom();
    el.roomInput.value = room;

    const payload = {
      t: 'invite',
      to: toId,
      room,
      fromId: getPresenceId(),
      fromName: myName,
      ts: Date.now()
    };

    ensureMqtt(() => {
      try {
        state.mqtt.publish(
          `${PRESENCE_TOPIC}/invite/${toId}`,
          JSON.stringify(payload),
          { qos: 0 }
        );
        // also general channel for older clients
        state.mqtt.publish(PRESENCE_TOPIC, JSON.stringify({ ...payload, t: 'invite-broadcast' }), { qos: 0 });
      } catch (e) {
        console.warn(e);
      }
      toast(`Invite sent to ${toName}`, 'ok');
      // Host joins the room so friend can enter
      if (!state.room) {
        closeNearby();
        setTimeout(() => el.btnJoin.click(), 200);
      } else if (state.room !== room) {
        joinRoomCode(room);
      }
    });
  }

  function presencePayload() {
    const name = (state.name || el.nameInput?.value || '').trim().slice(0, 24);
    if (!name) return null;
    return {
      t: 'presence',
      id: getPresenceId(),
      name,
      room: state.room || '',
      status: state.room ? 'room' : 'online',
      ts: Date.now()
    };
  }

  function publishPresence(force) {
    const payload = presencePayload();
    if (!payload) {
      updatePresenceHint();
      return;
    }
    // Local self immediately
    upsertPerson(payload);
    renderNearbyList();
    updatePresenceHint();

    ensureMqtt(() => {
      if (!state.mqtt || !state.mqttReady) return;
      try {
        state.mqtt.publish(PRESENCE_TOPIC, JSON.stringify(payload), { qos: 0 });
      } catch (e) {
        console.warn('publish presence', e);
      }
    });
  }

  function startPresenceLoop() {
    if (state.presenceTimer) return;
    state.presenceTimer = setInterval(() => {
      publishPresence();
      prunePeople();
      renderNearbyList();
    }, 5000);
  }

  function stopPresenceLoop() {
    if (state.presenceTimer) {
      clearInterval(state.presenceTimer);
      state.presenceTimer = null;
    }
  }

  function updatePresenceHint() {
    const hint = $('#presenceHint');
    if (!hint) return;
    const name = (el.nameInput?.value || '').trim();
    if (!name) {
      hint.textContent = 'Type name → you appear in Nearby for others';
      hint.classList.add('off');
      return;
    }
    if (state.mqttReady) {
      hint.textContent = `Online as “${name}” · others can see you in Nearby`;
      hint.classList.remove('off');
    } else {
      hint.textContent = `Connecting as “${name}”…`;
      hint.classList.add('off');
    }
  }

  function ensureMqtt(cb) {
    if (state.mqtt && state.mqttReady) {
      if (typeof cb === 'function') cb();
      return;
    }
    if (state.mqtt && !state.mqttReady) {
      // wait a bit
      if (typeof cb === 'function') {
        const t0 = Date.now();
        const wait = setInterval(() => {
          if (state.mqttReady) {
            clearInterval(wait);
            cb();
          } else if (Date.now() - t0 > 8000) {
            clearInterval(wait);
          }
        }, 200);
      }
      return;
    }

    const M = getMqttLib();
    if (!M || typeof M.connect !== 'function') {
      if (el.nearbyStatus) el.nearbyStatus.textContent = 'MQTT lib missing — hard refresh (Ctrl+F5)';
      console.warn('mqtt.js not loaded', M);
      toast('Nearby library failed — refresh page', 'err');
      return;
    }

    const pid = getPresenceId();
    let urlIndex = 0;
    let connecting = false;

    const connectNext = () => {
      if (connecting) return;
      if (urlIndex >= MQTT_URLS.length) {
        if (el.nearbyStatus) el.nearbyStatus.textContent = 'Presence offline — try Refresh';
        state.mqttReady = false;
        updatePresenceHint();
        // retry from first broker after pause
        setTimeout(() => {
          urlIndex = 0;
          connectNext();
        }, 5000);
        return;
      }
      const url = MQTT_URLS[urlIndex++];
      connecting = true;
      try {
        if (state.mqtt) {
          try { state.mqtt.end(true); } catch {}
          state.mqtt = null;
        }
        const client = M.connect(url, {
          clientId: 'qrtrx_' + pid + '_' + Math.random().toString(16).slice(2, 6),
          clean: true,
          connectTimeout: 10000,
          reconnectPeriod: 5000,
          keepalive: 20
        });
        state.mqtt = client;

        client.on('connect', () => {
          connecting = false;
          state.mqttReady = true;
          if (el.nearbyStatus) el.nearbyStatus.textContent = 'Presence online';
          try {
            client.subscribe(PRESENCE_TOPIC, { qos: 0 });
            client.subscribe(PRESENCE_TOPIC + '/invite/' + pid, { qos: 0 });
          } catch (e) {
            console.warn(e);
          }
          // Request isn't needed — just spam our presence so others see us
          publishPresence(true);
          startPresenceLoop();
          updatePresenceHint();
          renderNearbyList();
          if (typeof cb === 'function') {
            const fn = cb;
            cb = null;
            fn();
          }
        });

        client.on('message', (topic, buf) => {
          let data;
          try { data = JSON.parse(String(buf)); } catch { return; }
          onMqttMessage(topic, data);
        });

        client.on('error', (err) => {
          console.warn('mqtt error', err);
        });

        client.on('close', () => {
          state.mqttReady = false;
          updatePresenceHint();
        });

        client.on('offline', () => {
          state.mqttReady = false;
        });

        // if not connected soon, try next broker
        setTimeout(() => {
          if (!state.mqttReady && state.mqtt === client) {
            connecting = false;
            try { client.end(true); } catch {}
            connectNext();
          } else {
            connecting = false;
          }
        }, 10000);
      } catch (e) {
        connecting = false;
        console.warn(e);
        connectNext();
      }
    };

    connectNext();
  }

  function onMqttMessage(topic, data) {
    if (!data || typeof data !== 'object') return;

    if (data.t === 'presence' && data.id) {
      // clock-skew tolerant (5 min)
      if (data.ts && Math.abs(Date.now() - data.ts) > 5 * 60 * 1000) return;
      upsertPerson(data);
      renderNearbyList();
      return;
    }

    // Direct invite to me
    if (data.t === 'invite' && data.to === getPresenceId() && data.room) {
      toast(`${data.fromName || 'Someone'} invited you → ${data.room}`, 'ok');
      el.roomInput.value = data.room;
      if (el.nearbyRoomInput) el.nearbyRoomInput.value = data.room;
      // Auto-join after short delay if we have a name
      if ((el.nameInput.value || loadName() || '').trim()) {
        setTimeout(() => joinRoomCode(data.room), 600);
      } else {
        openNearby();
        el.nameInput?.focus();
      }
      return;
    }

    if (data.t === 'invite-broadcast' && data.to === getPresenceId() && data.room) {
      onMqttMessage(topic, { ...data, t: 'invite' });
    }

    // MQTT chat relay (works even when PeerJS mesh is flaky)
    if (data.t === 'chat-relay' && data.text) {
      const myName = (state.name || el.nameInput?.value || '').trim().toLowerCase();
      const to = String(data.toName || '').trim().toLowerCase();
      const from = String(data.fromName || 'Someone');
      const sameRoom = !!(state.room && data.room && String(state.room).toUpperCase() === String(data.room).toUpperCase());
      const toMe = !!(to && myName && (myName === to || myName.includes(to) || to.includes(myName)));
      const toAll = !to || data.broadcast === true;
      if (data.fromId && data.fromId === getPresenceId()) return;
      if (sameRoom || toMe || (toAll && sameRoom)) {
        // If on join screen, still toast
        if (el.viewRoom?.classList.contains('active')) {
          addChat({ name: from, text: String(data.text).slice(0, 4000), me: false });
        }
        toast(`${from}: ${String(data.text).slice(0, 80)}`, 'ok', 4000);
        try { navigator.vibrate?.(80); } catch {}
      } else if (toMe) {
        toast(`${from}: ${String(data.text).slice(0, 100)}`, 'ok', 5000);
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
    for (const f of list) {
      if (state.pendingFiles.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) continue;
      state.pendingFiles.push(f);
    }
    renderQueue();
  }

  function bind() {
    el.nameInput.value = loadName();
    el.roomInput.value = roomFromUrl() || '';

    el.btnRandomRoom.addEventListener('click', () => {
      el.roomInput.value = randomRoom();
      el.roomInput.focus();
    });

    el.btnJoin.addEventListener('click', () => {
      const name = (el.nameInput.value || 'Guest').trim().slice(0, 24);
      let room = (el.roomInput.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!room) room = randomRoom();
      el.roomInput.value = room;
      if (!window.Peer) {
        toast('PeerJS failed to load — check internet', 'err');
        return;
      }
      enterRoom(name, room);
    });

    // Name type → appear in Nearby people list
    el.nameInput.addEventListener('input', onNameTyped);
    el.nameInput.addEventListener('change', onNameTyped);
    el.nameInput.addEventListener('blur', onNameTyped);
    el.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.btnJoin.click();
    });
    el.roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.btnJoin.click(); });

    el.btnLeave.addEventListener('click', leave);
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
      const v = el.sendTarget.value;
      let targets;
      if (v === '*') {
        targets = [...state.peers.keys()].filter((id) => id !== state.id && state.conns.has(id));
      } else {
        targets = state.conns.has(v) ? [v] : [];
      }
      if (!targets.length) {
        toast('No one to send to yet', 'err');
        return;
      }
      el.btnSendFiles.disabled = true;
      try {
        await sendFilesTo(targets);
      } finally {
        renderQueue();
      }
    });

    document.addEventListener('paste', (e) => {
      if (!el.viewRoom.classList.contains('active')) return;
      if (e.clipboardData?.files?.length) addFiles(e.clipboardData.files);
    });
  }

  // Auto-join if room in URL + name saved
  bind();
  // Always spin up presence early
  setTimeout(() => {
    if (loadName()) onNameTyped();
    else ensureMqtt(); // connect so we at least receive others if name typed later
  }, 200);
  if (roomFromUrl() && loadName() && window.Peer) {
    el.roomInput.value = roomFromUrl();
    setTimeout(() => el.btnJoin.click(), 500);
  } else if (roomFromUrl()) {
    el.roomInput.value = roomFromUrl();
  }
})();

/**
 * HiveDrop — GitHub Pages friendly LAN chat + file share
 * PeerJS free cloud for signaling · WebRTC DataChannels for P2P (LAN preferred)
 */
(() => {
  'use strict';

  const CHUNK = 16 * 1024; // 16 KB
  const MAX_FILE = 200 * 1024 * 1024; // 200 MB soft cap per file
  const PEER_PREFIX = 'hivedrop-';
  const NEARBY_HUB_ID = 'qrtrx-nearby-hub-v1';
  const NEARBY_TTL_MS = 70_000;

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
    qrCanvas: $('#qrCanvas'),
    joinUrl: $('#joinUrl'),
    btnCopyModal: $('#btnCopyModal'),
    nearbyModal: $('#nearbyModal'),
    nearbyList: $('#nearbyList'),
    nearbyStatus: $('#nearbyStatus'),
    btnRefreshNearby: $('#btnRefreshNearby'),
    btnStartCam: $('#btnStartCam'),
    btnStopCam: $('#btnStopCam'),
    qrReader: $('#qrReader'),
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
    // nearby
    nearbyPeer: null,
    nearbyConn: null,
    nearbyRooms: new Map(), // room -> { name, room, url, ts }
    announceTimer: null,
    html5Qr: null,
    isNearbyHub: false,
    nearbyHubConns: new Map(),
  };

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
    return PEER_PREFIX + room.toLowerCase() + '-host';
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
    stopAnnouncing();
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

    client.on('open', (id) => {
      state.id = id;
      state.peers.set(id, { id, name, isHost: false });
      // Connect to host
      const conn = client.connect(hid, { reliable: true });
      wireConn(conn);
      onJoined();
    });

    client.on('connection', (conn) => {
      // mesh from others
      wireConn(conn);
    });

    client.on('error', (err) => {
      console.warn('client error', err);
      if (err?.type === 'peer-unavailable') {
        toast('Host not found — create room first or check code', 'err');
        setStatus('');
        el.btnJoin.disabled = false;
        el.btnJoin.innerHTML = 'Enter hive <span>→</span>';
        destroyPeer();
        showJoin();
      } else if (err?.type === 'network') {
        toast('Network error — need internet for first connect', 'err');
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

    if (state.isHost) {
      setTimeout(() => openQr(), 350);
      // Broadcast room to Nearby live list
      startAnnouncing();
    } else {
      // members can also appear optional — only host announces
    }
  }

  // ── QR ─────────────────────────────────────────────────
  function openQr() {
    const url = joinUrl();
    el.joinUrl.textContent = url;
    el.qrModal.classList.remove('hidden');
    if (window.QRCode) {
      QRCode.toCanvas(el.qrCanvas, url, {
        width: 260,
        margin: 2,
        color: { dark: '#0f172a', light: '#ffffff' }
      }, (err) => { if (err) console.warn(err); });
    }
  }
  function closeQr() { el.qrModal.classList.add('hidden'); }

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
    stopAnnouncing();
    destroyPeer();
    const u = new URL(location.href);
    u.searchParams.delete('room');
    history.replaceState(null, '', u.pathname + u.hash);
    showJoin();
    toast('Left room');
  }

  // ── Nearby: live rooms + camera QR ─────────────────────
  function openNearby() {
    el.nearbyModal.classList.remove('hidden');
    switchNearbyTab('camera');
    startNearbyClient();
  }

  function closeNearby() {
    stopCamera();
    // keep nearby peer for announce if in room; only destroy if not announcing
    if (!state.announceTimer) {
      destroyNearbyPeer();
    }
    el.nearbyModal.classList.add('hidden');
  }

  function switchNearbyTab(name) {
    $$('.nearby-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    el.tabCamera.classList.toggle('active', name === 'camera');
    el.tabLive.classList.toggle('active', name === 'live');
    if (name === 'live') {
      stopCamera();
      startNearbyClient();
      renderNearbyList();
    }
  }

  function destroyNearbyPeer() {
    try {
      for (const c of state.nearbyHubConns.values()) c.close();
    } catch {}
    state.nearbyHubConns.clear();
    try { state.nearbyConn?.close(); } catch {}
    state.nearbyConn = null;
    try { state.nearbyPeer?.destroy(); } catch {}
    state.nearbyPeer = null;
    state.isNearbyHub = false;
  }

  function pruneNearby() {
    const now = Date.now();
    for (const [room, info] of state.nearbyRooms) {
      if (now - info.ts > NEARBY_TTL_MS) state.nearbyRooms.delete(room);
    }
  }

  function renderNearbyList() {
    pruneNearby();
    const rooms = [...state.nearbyRooms.values()].sort((a, b) => b.ts - a.ts);
    if (!rooms.length) {
      el.nearbyList.innerHTML = '<li class="nearby-empty">No rooms yet — open a room on another device (it appears automatically)</li>';
      return;
    }
    el.nearbyList.innerHTML = rooms.map((r) => {
      const age = Math.max(0, Math.round((Date.now() - r.ts) / 1000));
      return `<li class="nearby-item" data-room="${escapeHtml(r.room)}" data-url="${escapeHtml(r.url || '')}">
        <div class="av">${escapeHtml(initials(r.name))}</div>
        <div class="meta">
          <div class="nm">${escapeHtml(r.name || 'Host')}</div>
          <div class="rm">${escapeHtml(r.room)} · ${age}s ago</div>
        </div>
        <span class="join-chip">Join →</span>
      </li>`;
    }).join('');

    el.nearbyList.querySelectorAll('.nearby-item').forEach((item) => {
      item.addEventListener('click', () => {
        const room = item.dataset.room;
        if (!room) return;
        el.roomInput.value = room;
        closeNearby();
        toast(`Room ${room} selected`, 'ok');
        // auto join if name set
        if ((el.nameInput.value || '').trim()) {
          el.btnJoin.click();
        } else {
          el.nameInput.focus();
        }
      });
    });
  }

  function handleNearbyData(data, fromConn) {
    if (!data || typeof data !== 'object') return;

    if (data.t === 'announce' && data.room) {
      state.nearbyRooms.set(data.room, {
        name: data.name || 'Host',
        room: String(data.room).toUpperCase(),
        url: data.url || '',
        ts: data.ts || Date.now()
      });
      if (state.isNearbyHub) {
        // relay to all scanners
        for (const c of state.nearbyHubConns.values()) {
          if (c !== fromConn && c.open) {
            try { c.send(data); } catch {}
          }
        }
      }
      renderNearbyList();
      if (el.nearbyStatus) el.nearbyStatus.textContent = `${state.nearbyRooms.size} live room(s)`;
    }

    if (data.t === 'room-list' && Array.isArray(data.rooms)) {
      for (const r of data.rooms) {
        if (!r?.room) continue;
        state.nearbyRooms.set(r.room, {
          name: r.name || 'Host',
          room: String(r.room).toUpperCase(),
          url: r.url || '',
          ts: r.ts || Date.now()
        });
      }
      renderNearbyList();
      if (el.nearbyStatus) el.nearbyStatus.textContent = `${state.nearbyRooms.size} live room(s)`;
    }

    if (data.t === 'scan-hello' && state.isNearbyHub && fromConn) {
      pruneNearby();
      try {
        fromConn.send({
          t: 'room-list',
          rooms: [...state.nearbyRooms.values()]
        });
      } catch {}
    }
  }

  function wireNearbyConn(conn, asHub) {
    conn.on('open', () => {
      if (asHub) {
        state.nearbyHubConns.set(conn.peer, conn);
        pruneNearby();
        try {
          conn.send({ t: 'room-list', rooms: [...state.nearbyRooms.values()] });
        } catch {}
      } else {
        state.nearbyConn = conn;
        try { conn.send({ t: 'scan-hello' }); } catch {}
        // if we are in a room, announce
        if (state.room && state.name) sendAnnounce();
      }
      if (el.nearbyStatus) el.nearbyStatus.textContent = 'Connected · listening';
    });
    conn.on('data', (d) => handleNearbyData(d, conn));
    conn.on('close', () => {
      state.nearbyHubConns.delete(conn.peer);
      if (state.nearbyConn === conn) state.nearbyConn = null;
    });
  }

  function startNearbyClient() {
    if (!window.Peer) {
      if (el.nearbyStatus) el.nearbyStatus.textContent = 'PeerJS missing — check internet';
      return;
    }
    if (state.nearbyPeer && !state.nearbyPeer.destroyed) {
      // already up — request refresh
      if (state.nearbyConn?.open) {
        try { state.nearbyConn.send({ t: 'scan-hello' }); } catch {}
      }
      renderNearbyList();
      return;
    }

    if (el.nearbyStatus) el.nearbyStatus.textContent = 'Connecting…';

    // Try become hub first (first visitor becomes discovery hub)
    const hub = new Peer(NEARBY_HUB_ID, peerConfig());
    let settled = false;

    const asClient = () => {
      if (settled) return;
      settled = true;
      try { hub.destroy(); } catch {}
      const client = new Peer(peerConfig());
      state.nearbyPeer = client;
      state.isNearbyHub = false;
      client.on('open', () => {
        const conn = client.connect(NEARBY_HUB_ID, { reliable: true });
        wireNearbyConn(conn, false);
      });
      client.on('error', (err) => {
        console.warn('nearby client', err);
        if (el.nearbyStatus) el.nearbyStatus.textContent = 'Nearby offline — use Camera QR';
      });
    };

    hub.on('open', () => {
      if (settled) return;
      settled = true;
      state.nearbyPeer = hub;
      state.isNearbyHub = true;
      if (el.nearbyStatus) el.nearbyStatus.textContent = 'Hub ready · waiting for rooms';
      hub.on('connection', (conn) => wireNearbyConn(conn, true));
      // also announce if already in room
      if (state.room) startAnnouncing();
    });

    hub.on('error', (err) => {
      if (err?.type === 'unavailable-id') asClient();
    });

    setTimeout(() => { if (!settled) asClient(); }, 4000);
  }

  function announcePayload() {
    return {
      t: 'announce',
      name: state.name || el.nameInput.value || 'Host',
      room: state.room,
      url: joinUrl(),
      ts: Date.now()
    };
  }

  function sendAnnounce() {
    if (!state.room) return;
    const payload = announcePayload();
    // self list
    state.nearbyRooms.set(payload.room, {
      name: payload.name,
      room: payload.room,
      url: payload.url,
      ts: payload.ts
    });

    if (state.isNearbyHub) {
      for (const c of state.nearbyHubConns.values()) {
        if (c.open) try { c.send(payload); } catch {}
      }
    } else if (state.nearbyConn?.open) {
      try { state.nearbyConn.send(payload); } catch {}
    } else {
      // ensure nearby link
      startNearbyClient();
    }
  }

  function startAnnouncing() {
    stopAnnouncing();
    startNearbyClient();
    sendAnnounce();
    state.announceTimer = setInterval(sendAnnounce, 12_000);
  }

  function stopAnnouncing() {
    if (state.announceTimer) {
      clearInterval(state.announceTimer);
      state.announceTimer = null;
    }
  }

  // Camera QR
  async function startCamera() {
    if (!window.Html5Qrcode) {
      toast('QR scanner lib missing — check internet', 'err');
      return;
    }
    stopCamera();
    const readerId = 'qrReader';
    state.html5Qr = new Html5Qrcode(readerId);
    el.btnStartCam.classList.add('hidden');
    el.btnStopCam.classList.remove('hidden');
    try {
      await state.html5Qr.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decoded) => onQrDecoded(decoded),
        () => {}
      );
    } catch (e) {
      console.warn(e);
      // try user facing
      try {
        await state.html5Qr.start(
          { facingMode: 'user' },
          { fps: 10, qrbox: { width: 220, height: 220 } },
          (decoded) => onQrDecoded(decoded),
          () => {}
        );
      } catch (e2) {
        toast('Camera permission needed', 'err');
        el.btnStartCam.classList.remove('hidden');
        el.btnStopCam.classList.add('hidden');
        state.html5Qr = null;
      }
    }
  }

  async function stopCamera() {
    if (state.html5Qr) {
      try {
        if (state.html5Qr.isScanning) await state.html5Qr.stop();
        await state.html5Qr.clear();
      } catch {}
      state.html5Qr = null;
    }
    el.btnStartCam?.classList.remove('hidden');
    el.btnStopCam?.classList.add('hidden');
  }

  function onQrDecoded(text) {
    if (!text) return;
    let room = '';
    try {
      if (text.includes('room=')) {
        const u = new URL(text, location.href);
        room = (u.searchParams.get('room') || '').toUpperCase();
      } else if (/^[A-Z0-9]{4,8}$/i.test(text.trim())) {
        room = text.trim().toUpperCase();
      }
    } catch {
      const m = String(text).match(/room=([A-Za-z0-9]{4,8})/i);
      if (m) room = m[1].toUpperCase();
    }
    if (!room) {
      toast('Not a HiveDrop QR', 'err');
      return;
    }
    stopCamera();
    el.roomInput.value = room;
    closeNearby();
    toast(`Scanned room ${room}`, 'ok');
    if ((el.nameInput.value || loadName() || '').trim()) {
      el.btnJoin.click();
    } else {
      el.nameInput.focus();
      toast('Type your name, then Enter hive', '');
    }
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

    el.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.btnJoin.click(); });
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
    el.btnStartCam?.addEventListener('click', startCamera);
    el.btnStopCam?.addEventListener('click', stopCamera);
    el.btnRefreshNearby?.addEventListener('click', () => {
      if (el.nearbyStatus) el.nearbyStatus.textContent = 'Refreshing…';
      startNearbyClient();
      if (state.nearbyConn?.open) {
        try { state.nearbyConn.send({ t: 'scan-hello' }); } catch {}
      }
      renderNearbyList();
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
  if (roomFromUrl() && loadName() && window.Peer) {
    el.roomInput.value = roomFromUrl();
    setTimeout(() => el.btnJoin.click(), 200);
  } else if (roomFromUrl()) {
    el.roomInput.value = roomFromUrl();
  }
})();

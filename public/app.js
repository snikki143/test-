(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    login: $('login'), loginForm: $('loginForm'), loginError: $('loginError'), joinBtn: $('joinBtn'),
    name: $('name'), room: $('room'), password: $('password'),
    chat: $('chat'), peerName: $('peerName'), peerStatus: $('peerStatus'), peerAvatar: $('peerAvatar'),
    banner: $('banner'), list: $('messages'), toBottom: $('toBottom'), unread: $('unreadCount'),
    composer: $('composer'), input: $('input'), sendBtn: $('sendBtn'), logout: $('logoutBtn'), toast: $('toast'),
  };

  const TITLE = 'Our Chat';
  const coarse = matchMedia('(pointer: coarse)').matches; // phones/tablets: Enter = new line

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  /* ------------------------------------------------------------------ state */
  let token = store.get('chat.token');
  let me = null;
  let peer = null;
  let source = null;            // EventSource
  let msgs = [];                // sorted by id
  const nodes = new Map();      // id -> { row, tick }
  let prev = null;              // last rendered message (for grouping)
  let rendered = false;
  let unread = 0;
  let lastSeenSent = 0;
  let lastPing = 0;
  let recovering = false;
  let peerTyping = false;
  let iAmTyping = false;
  let lastTypingSent = 0;
  let typingHideTimer = null;
  let typingStopTimer = null;
  let toastTimer = null;

  /* ---------------------------------------------------------------- helpers */
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d; };

  function dayLabel(ts) {
    const k = dayKey(ts);
    if (k === dayKey(Date.now())) return 'Today';
    if (k === dayKey(yesterday())) return 'Yesterday';
    const d = new Date(ts);
    return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  function lastSeenText(ts) {
    if (!ts) return 'offline';
    if (Date.now() - ts < 60000) return 'last seen just now';
    const k = dayKey(ts);
    if (k === dayKey(Date.now())) return `last seen today at ${fmtTime(ts)}`;
    if (k === dayKey(yesterday())) return `last seen yesterday at ${fmtTime(ts)}`;
    return `last seen ${new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
  }

  function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360; return h; }
  function paintAvatar(node, name) {
    node.textContent = (Array.from(name.trim())[0] || '?').toUpperCase();
    const h = hue(name);
    node.style.background = `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 70% 45%))`;
  }

  const TICK1 = '<svg viewBox="0 0 16 11" aria-label="Sent"><path d="M2 5.8 5.4 9.2 13.6 1.4"/></svg>';
  const TICK2 = '<svg viewBox="0 0 16 11" aria-label="Seen"><path d="M1 5.8 4.4 9.2 11.6 1.6"/><path d="M7.2 9.2 14.8 1.6"/></svg>';

  const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;
  function linkify(node, text) {
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
      if (m.index > last) node.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = m[0];
      a.textContent = m[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      node.append(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) node.append(text.slice(last));
  }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3500);
  }

  function setBanner(text) {
    el.banner.textContent = text;
    el.banner.classList.toggle('hidden', !text);
  }

  const visibleFocus = () => document.visibilityState === 'visible' && document.hasFocus();
  const atBottom = () => el.list.scrollHeight - el.list.scrollTop - el.list.clientHeight < 80;
  function scrollBottom(smooth) { el.list.scrollTo({ top: el.list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); }

  function updateUnreadUi() {
    el.toBottom.classList.toggle('hidden', atBottom());
    el.unread.textContent = unread ? String(unread) : '';
    document.title = unread ? `(${unread}) ${TITLE}` : TITLE;
  }

  /* -------------------------------------------------------------------- api */
  async function api(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...body }),
    });
    let data = {};
    try { data = await r.json(); } catch { /* non-JSON error page */ }
    if (!r.ok) {
      if (r.status === 401 && path !== '/api/join') signOut('Your session has ended. Please sign in again.');
      const err = new Error(data.error || `Something went wrong (${r.status}).`);
      err.status = r.status;
      throw err;
    }
    return data;
  }

  /* ----------------------------------------------------------------- header */
  function renderHeader() {
    const s = el.peerStatus;
    if (!me) { el.peerName.textContent = 'Connecting…'; s.className = 'status'; s.textContent = ''; return; }
    if (!peer) {
      el.peerName.textContent = 'Waiting for someone…';
      s.className = 'status';
      s.textContent = 'Share the room name and password';
      el.peerAvatar.textContent = '…';
      el.peerAvatar.style.background = '';
      return;
    }
    el.peerName.textContent = peer.name;
    paintAvatar(el.peerAvatar, peer.name);
    if (peerTyping) {
      s.className = 'status typing';
      s.textContent = 'typing';
      const dots = document.createElement('span');
      dots.className = 'dots';
      dots.innerHTML = '<i></i><i></i><i></i>';
      s.append(dots);
    } else if (peer.online) {
      s.className = 'status online';
      s.textContent = 'online';
    } else {
      s.className = 'status';
      s.textContent = lastSeenText(peer.lastSeen);
    }
  }

  /* --------------------------------------------------------------- messages */
  function emptyState() {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = peer ? 'No messages yet. Say hi 👋' : 'Share the room name and password so the other person can join.';
    return d;
  }

  function renderAll() {
    el.list.replaceChildren();
    nodes.clear();
    prev = null;
    if (!msgs.length) { el.list.append(emptyState()); return; }
    for (const m of msgs) appendMsg(m, false);
  }

  function appendMsg(m, animate) {
    const empty = el.list.querySelector('.empty');
    if (empty) empty.remove();

    if (!prev || dayKey(prev.ts) !== dayKey(m.ts)) {
      const d = document.createElement('div');
      d.className = 'day';
      d.textContent = dayLabel(m.ts);
      el.list.append(d);
      prev = null;
    }

    const mine = m.from === me.id;
    const cont = !!prev && prev.from === m.from && m.ts - prev.ts < 120000;
    if (cont) { const p = nodes.get(prev.id); if (p) p.row.classList.remove('tail'); }

    const row = document.createElement('div');
    row.className = `msg ${mine ? 'out' : 'in'} tail${cont ? ' cont' : ''}${animate ? ' pop' : ''}`;
    row.dataset.id = m.id;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const text = document.createElement('span');
    text.className = 'text';
    linkify(text, m.text);

    const meta = document.createElement('span');
    meta.className = 'meta';
    const time = document.createElement('time');
    time.dateTime = new Date(m.ts).toISOString();
    time.textContent = fmtTime(m.ts);
    meta.append(time);

    let tick = null;
    if (mine) {
      tick = document.createElement('span');
      tick.className = 'tick' + (m.seen ? ' seen' : '');
      tick.innerHTML = m.seen ? TICK2 : TICK1;
      meta.append(tick);
    }

    bubble.append(text, meta);
    row.append(bubble);
    el.list.append(row);
    nodes.set(m.id, { row, tick });
    prev = m;
  }

  function onMessage(m) {
    if (msgs.some((x) => x.id === m.id)) return; // POST reply and stream echo both arrive
    const stick = atBottom();
    const last = msgs[msgs.length - 1];
    msgs.push(m);
    if (last && m.id < last.id) { msgs.sort((a, b) => a.id - b.id); renderAll(); }
    else appendMsg(m, true);

    if (m.from === me.id) { scrollBottom(true); return; }

    if (peerTyping) { peerTyping = false; renderHeader(); }
    if (stick && visibleFocus()) { scrollBottom(true); markSeen(); }
    else { unread++; updateUnreadUi(); notify(m); }
  }

  function applySeen(by, upTo) {
    if (me && by === me.id) lastSeenSent = Math.max(lastSeenSent, upTo);
    for (const m of msgs) {
      if (m.from === by || m.id > upTo || m.seen) continue;
      m.seen = true;
      const n = nodes.get(m.id);
      if (n && n.tick) { n.tick.classList.add('seen'); n.tick.innerHTML = TICK2; }
    }
  }

  function markSeen() {
    if (!me || !visibleFocus() || !atBottom()) return;
    unread = 0;
    updateUnreadUi();
    let top = 0;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].from !== me.id) { top = msgs[i].id; break; }
    if (top > lastSeenSent) {
      const before = lastSeenSent;
      lastSeenSent = top;
      api('/api/seen', { upTo: top }).catch(() => { if (lastSeenSent === top) lastSeenSent = before; });
    }
  }

  function notify(m) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || visibleFocus()) return;
    try {
      const n = new Notification(peer ? peer.name : 'New message', { body: m.text.slice(0, 140), tag: 'chat' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
  }

  /* ------------------------------------------------------------------ typing */
  function onTyping() {
    if (!el.input.value.trim()) { stopTyping(); return; }
    const now = Date.now();
    if (!iAmTyping || now - lastTypingSent > 2500) {
      iAmTyping = true;
      lastTypingSent = now;
      api('/api/typing', { typing: true }).catch(() => {});
    }
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(stopTyping, 3000);
  }
  function stopTyping() {
    clearTimeout(typingStopTimer);
    if (iAmTyping) { iAmTyping = false; api('/api/typing', { typing: false }).catch(() => {}); }
  }

  /* -------------------------------------------------------------- connection */
  function disconnect() {
    if (source) { source.close(); source = null; }
  }

  function connect() {
    disconnect();
    setBanner('Connecting…');
    const es = new EventSource('/api/stream?token=' + encodeURIComponent(token));
    source = es;
    lastPing = Date.now();

    es.addEventListener('init', (e) => { lastPing = Date.now(); onInit(JSON.parse(e.data)); });
    es.addEventListener('msg', (e) => { lastPing = Date.now(); onMessage(JSON.parse(e.data)); });
    es.addEventListener('peer', (e) => {
      peer = JSON.parse(e.data);
      if (!peer.online) peerTyping = false;
      renderHeader();
      if (!msgs.length) renderAll();
    });
    es.addEventListener('typing', (e) => {
      peerTyping = !!JSON.parse(e.data).typing;
      clearTimeout(typingHideTimer);
      if (peerTyping) typingHideTimer = setTimeout(() => { peerTyping = false; renderHeader(); }, 5000);
      renderHeader();
    });
    es.addEventListener('seen', (e) => { const d = JSON.parse(e.data); applySeen(d.by, d.upTo); });
    es.addEventListener('ping', () => { lastPing = Date.now(); });
    es.onopen = () => setBanner('');
    es.onerror = () => {
      if (es !== source) return;
      setBanner('Reconnecting…');
      // The browser retries by itself, unless the response was a hard failure (CLOSED).
      if (es.readyState === EventSource.CLOSED) recover();
    };
  }

  async function recover() {
    if (recovering || !token) return;
    recovering = true;
    try {
      await api('/api/ping'); // 401 here signs us out; any other error means "server not back yet"
      recovering = false;
      connect();
    } catch (e) {
      recovering = false;
      if (e.status !== 401 && token) setTimeout(recover, 3000);
    }
  }

  function onInit(d) {
    me = d.me;
    peer = d.peer;
    msgs = d.messages;
    peerTyping = false;
    lastSeenSent = msgs.reduce((hi, m) => (m.from !== me.id && m.seen ? Math.max(hi, m.id) : hi), 0);
    const stick = !rendered || atBottom();
    rendered = true;
    showChat();
    renderAll();
    renderHeader();
    setBanner('');
    if (stick) scrollBottom(false);
    unread = 0;
    updateUnreadUi();
    markSeen();
  }

  /* ----------------------------------------------------------------- screens */
  function showChat() {
    el.login.classList.add('hidden');
    el.chat.classList.remove('hidden');
  }

  function showLogin(message) {
    el.chat.classList.add('hidden');
    el.login.classList.remove('hidden');
    el.loginError.textContent = message || '';
    el.name.value = store.get('chat.name') || '';
    el.room.value = store.get('chat.room') || '';
    el.password.value = '';
    (el.name.value ? el.password : el.name).focus();
  }

  function signOut(message) {
    disconnect();
    token = null;
    store.del('chat.token');
    me = null; peer = null; msgs = []; rendered = false; unread = 0; lastSeenSent = 0; peerTyping = false;
    nodes.clear();
    el.list.replaceChildren();
    document.title = TITLE;
    showLogin(message);
  }

  /* ------------------------------------------------------------------ events */
  el.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    el.loginError.textContent = '';
    el.joinBtn.disabled = true;
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission().catch(() => {}); } catch { /* old Safari */ }
    }
    try {
      const name = el.name.value, room = el.room.value;
      token = null;
      const r = await api('/api/join', { name, room, password: el.password.value });
      token = r.token;
      store.set('chat.token', token);
      store.set('chat.name', r.name);
      store.set('chat.room', room.trim());
      el.password.value = '';
      showChat();
      renderHeader();
      connect();
    } catch (err) {
      el.loginError.textContent = err.message;
    } finally {
      el.joinBtn.disabled = false;
    }
  });

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 140) + 'px';
  }

  async function send() {
    const text = el.input.value.trim();
    if (!text || !me) return;
    el.input.value = '';
    autosize();
    el.sendBtn.disabled = true;
    stopTyping();
    el.input.focus();
    try {
      const r = await api('/api/send', { text });
      onMessage(r.message);
    } catch (err) {
      if (!el.input.value) { el.input.value = text; autosize(); el.sendBtn.disabled = false; }
      toast(err.message);
    }
  }

  el.input.addEventListener('input', () => {
    autosize();
    el.sendBtn.disabled = !el.input.value.trim();
    onTyping();
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); send(); }
  });
  el.composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  el.sendBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep keyboard open

  el.list.addEventListener('scroll', () => { updateUnreadUi(); if (atBottom()) markSeen(); }, { passive: true });
  el.toBottom.addEventListener('click', () => { scrollBottom(true); setTimeout(markSeen, 350); });

  el.logout.addEventListener('click', () => {
    if (!confirm('Sign out on this device? Your messages stay saved.')) return;
    const p = api('/api/logout');
    signOut('');
    p.catch(() => {});
  });

  addEventListener('focus', markSeen);
  addEventListener('online', () => { if (token) connect(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !token) return;
    if (Date.now() - lastPing > 40000) connect(); // phone was asleep; the stream is probably dead
    markSeen();
  });

  // Watchdog (server pings every 25s) and keeping "last seen" fresh
  setInterval(() => {
    if (token && source && Date.now() - lastPing > 60000) connect();
    if (peer) renderHeader();
  }, 15000);

  /* -------------------------------------------------------------------- boot */
  if (token) { showChat(); renderHeader(); connect(); }
  else showLogin('');
})();

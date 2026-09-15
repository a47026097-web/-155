/* دردشة — منطق الواجهة */

const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem('token') || null,
  me: null,
  contacts: [],
  peerId: null,
  messages: [],
  socket: null,
  typingTimer: null,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  call: null // { peerId, pc, localStream, status: 'calling' | 'incoming' | 'active', offerSdp? }
};

/* --------------------------------- أدوات --------------------------------- */

const api = async (url, options = {}) => {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'صار خطأ، جرّب مرة ثانية');
  return data;
};

const initials = (name) => name.trim().charAt(0).toUpperCase();

const clock = (ts) =>
  new Date(ts).toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' });

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'اليوم';
  if (same(d, yest)) return 'أمس';
  return d.toLocaleDateString('ar-IQ', { day: 'numeric', month: 'long' });
}

function listTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? clock(ts) : dayLabel(ts);
}

function lastSeenText(contact) {
  if (contact.online) return 'متصل الآن';
  if (!contact.lastSeen) return 'غير متصل';
  return `آخر ظهور ${listTime(contact.lastSeen)}`;
}

/* ------------------------------- شاشة الدخول ------------------------------- */

let mode = 'login';

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $('nameField').hidden = mode === 'login';
    $('nameField').querySelector('input').required = mode === 'register';
    $('authForm').querySelector('button').textContent = mode === 'login' ? 'دخول' : 'إنشاء الحساب';
    $('authError').hidden = true;
  });
});

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = {
    username: form.get('username'),
    password: form.get('password'),
    displayName: form.get('displayName')
  };
  try {
    const data = await api(`/api/${mode}`, { method: 'POST', body: JSON.stringify(body) });
    state.token = data.token;
    localStorage.setItem('token', data.token);
    start(data.user);
  } catch (err) {
    $('authError').textContent = err.message;
    $('authError').hidden = false;
  }
});

$('logout').addEventListener('click', () => {
  localStorage.removeItem('token');
  location.reload();
});

/* --------------------------------- التشغيل -------------------------------- */

async function boot() {
  if (!state.token) return;
  try {
    const { user } = await api('/api/me');
    start(user);
  } catch {
    localStorage.removeItem('token');
  }
}

function start(user) {
  state.me = user;
  $('gate').hidden = true;
  $('app').hidden = false;

  $('myName').textContent = user.displayName;
  $('myHandle').textContent = '@' + user.username;
  $('myAvatar').textContent = initials(user.displayName);

  connect();
  loadContacts();
  api('/api/ice-config')
    .then((d) => (state.iceServers = d.iceServers))
    .catch(() => {});
}

function connect() {
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('message:new', (msg) => {
    const other = msg.from === state.me.id ? msg.to : msg.from;

    if (other === state.peerId) {
      state.messages.push(msg);
      renderMessages();
      if (msg.from !== state.me.id) state.socket.emit('message:read', { from: state.peerId });
    }
    updateContact(other, (c) => {
      c.lastMessage = msg.body;
      c.lastAt = msg.createdAt;
      if (msg.from !== state.me.id && other !== state.peerId) c.unread = (c.unread || 0) + 1;
    });
  });

  state.socket.on('message:read', ({ ids }) => {
    const set = new Set(ids);
    state.messages.forEach((m) => {
      if (set.has(m.id)) m.readAt = Date.now();
    });
    renderMessages();
  });

  state.socket.on('typing', ({ from, isTyping }) => {
    if (from !== state.peerId) return;
    const contact = state.contacts.find((c) => c.id === from);
    $('peerStatus').textContent = isTyping ? 'يكتب الآن…' : lastSeenText(contact || {});
  });

  state.socket.on('call:invite', ({ from, name, sdp }) => {
    // إذا بمكالمة أصلاً، ارفض تلقائياً
    if (state.call) return state.socket.emit('call:reject', { to: from });
    const contact = state.contacts.find((c) => c.id === from);
    showIncomingCall(from, name || contact?.displayName || 'مجهول', sdp);
  });

  state.socket.on('call:answer', async ({ sdp }) => {
    if (!state.call?.pc) return;
    await state.call.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    setCallStatus('active');
  });

  state.socket.on('call:ice-candidate', ({ candidate }) => {
    if (!state.call?.pc || !candidate) return;
    state.call.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  });

  state.socket.on('call:reject', () => {
    if (state.call?.status === 'calling') {
      $('callStatus').textContent = 'رفض المكالمة';
      setTimeout(endCall, 1200);
    }
  });

  state.socket.on('call:end', ({ from }) => {
    if (state.call && state.call.peerId === from) endCall(true);
  });

  state.socket.on('presence', ({ userId, online, lastSeen }) => {
    updateContact(userId, (c) => {
      c.online = online;
      if (lastSeen) c.lastSeen = lastSeen;
    });
    if (userId === state.peerId) {
      const c = state.contacts.find((x) => x.id === userId);
      $('peerStatus').textContent = lastSeenText(c || {});
      $('peerAvatar').dataset.online = c?.online ? '1' : '0';
    }
  });
}

/* -------------------------------- الجهات -------------------------------- */

async function loadContacts() {
  const { contacts } = await api('/api/contacts');
  state.contacts = contacts;
  renderContacts();
}

function updateContact(id, mutate) {
  const c = state.contacts.find((x) => x.id === id);
  if (!c) return loadContacts();
  mutate(c);
  renderContacts();
}

$('search').addEventListener('input', renderContacts);

function renderContacts() {
  const term = $('search').value.trim().toLowerCase();
  const list = $('contacts');
  list.innerHTML = '';

  const visible = [...state.contacts]
    .filter((c) => !term || c.displayName.toLowerCase().includes(term) || c.username.includes(term))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

  if (!visible.length) {
    list.innerHTML =
      '<li class="contact"><div class="contact__text"><div class="contact__last">ما في أحد بهذا الاسم</div></div></li>';
    return;
  }

  visible.forEach((c) => {
    const li = document.createElement('li');
    li.className = 'contact' + (c.id === state.peerId ? ' is-active' : '');
    li.innerHTML = `
      <div class="avatar" data-online="${c.online ? 1 : 0}">${initials(c.displayName)}</div>
      <div class="contact__text">
        <div class="contact__row">
          <span class="contact__name"></span>
          <span class="contact__time">${listTime(c.lastAt)}</span>
        </div>
        <div class="contact__row">
          <span class="contact__last"></span>
          ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}
        </div>
      </div>`;
    li.querySelector('.contact__name').textContent = c.displayName;
    li.querySelector('.contact__last').textContent = c.lastMessage || 'ابدأ المحادثة';
    li.addEventListener('click', () => openChat(c.id));
    list.appendChild(li);
  });
}

/* -------------------------------- المحادثة ------------------------------- */

async function openChat(id) {
  state.peerId = id;
  const contact = state.contacts.find((c) => c.id === id);

  $('emptyState').hidden = true;
  $('chatInner').hidden = false;
  $('app').dataset.view = 'chat';

  $('peerName').textContent = contact.displayName;
  $('peerStatus').textContent = lastSeenText(contact);
  $('peerAvatar').textContent = initials(contact.displayName);
  $('peerAvatar').dataset.online = contact.online ? '1' : '0';

  const { messages } = await api(`/api/messages/${id}`);
  state.messages = messages;
  renderMessages();

  state.socket.emit('message:read', { from: id });
  updateContact(id, (c) => (c.unread = 0));
  $('input').focus();
}

$('back').addEventListener('click', () => {
  $('app').dataset.view = 'list';
  state.peerId = null;
  renderContacts();
});

function renderMessages() {
  const box = $('messages');
  box.innerHTML = '';
  let lastDay = '';

  state.messages.forEach((m) => {
    const day = dayLabel(m.createdAt);
    if (day !== lastDay) {
      lastDay = day;
      const sep = document.createElement('div');
      sep.className = 'day';
      sep.textContent = day;
      box.appendChild(sep);
    }

    const mine = m.from === state.me.id;
    const el = document.createElement('div');
    el.className = 'bubble' + (mine ? ' bubble--mine' : '');
    el.innerHTML = `
      <div class="bubble__body"></div>
      <div class="bubble__meta">
        <span>${clock(m.createdAt)}</span>
        ${mine ? `<span class="ticks${m.readAt ? ' is-read' : ''}">${m.readAt ? '✓✓' : '✓'}</span>` : ''}
      </div>`;
    el.querySelector('.bubble__body').textContent = m.body;
    box.appendChild(el);
  });

  box.scrollTop = box.scrollHeight;
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = $('input').value.trim();
  if (!body || !state.peerId) return;
  state.socket.emit('message:send', { to: state.peerId, body });
  $('input').value = '';
  state.socket.emit('typing', { to: state.peerId, isTyping: false });
});

$('input').addEventListener('input', () => {
  if (!state.peerId) return;
  state.socket.emit('typing', { to: state.peerId, isTyping: true });
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(
    () => state.socket.emit('typing', { to: state.peerId, isTyping: false }),
    1500
  );
});

/* ------------------------------ مكالمة صوتية (WebRTC) ----------------------------- */
// الصوت يمشي مباشرة بين الجهازين (peer-to-peer)، والسيرفر يوصّل بس رسائل التفاوض
// (offer/answer/ICE). خوادم STUN تساعد كل جهاز يعرف عنوانه العام ويثقب جداره الناري/الراوتر،
// وإذا الشبكة مقيدة جداً وما نفع STUN، تحتاج خادم TURN (شوف ملاحظة بـ README).

function makePeerConnection(peerId) {
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });

  pc.onicecandidate = (e) => {
    if (e.candidate) state.socket.emit('call:ice-candidate', { to: peerId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    $('remoteAudio').srcObject = e.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && state.call) {
      if (pc.connectionState === 'failed') $('callStatus').textContent = 'انقطع الاتصال — تأكد من الشبكة';
    }
  };

  return pc;
}

async function getMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert('ما قدرنا نوصل للمايكروفون. تأكد من صلاحية المتصفح.');
    return null;
  }
}

$('callBtn').addEventListener('click', startCall);

async function startCall() {
  if (state.call || !state.peerId) return;
  const stream = await getMic();
  if (!stream) return;

  const peerId = state.peerId;
  const pc = makePeerConnection(peerId);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  state.call = { peerId, pc, localStream: stream, status: 'calling' };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  state.socket.emit('call:invite', { to: peerId, name: state.me.displayName, sdp: offer });
  openCallLayer(peerId, 'calling');
}

function showIncomingCall(fromId, name, sdp) {
  state.call = { peerId: fromId, pc: null, localStream: null, status: 'incoming', offerSdp: sdp };
  openCallLayer(fromId, 'incoming', name);
}

$('acceptCall').addEventListener('click', async () => {
  const call = state.call;
  if (!call) return;
  const stream = await getMic();
  if (!stream) return endCall();

  const pc = makePeerConnection(call.peerId);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  call.pc = pc;
  call.localStream = stream;

  await pc.setRemoteDescription(new RTCSessionDescription(call.offerSdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  state.socket.emit('call:answer', { to: call.peerId, sdp: answer });

  setCallStatus('active');
});

$('rejectCall').addEventListener('click', () => {
  if (state.call) state.socket.emit('call:reject', { to: state.call.peerId });
  endCall();
});

$('endCall').addEventListener('click', () => {
  if (state.call) state.socket.emit('call:end', { to: state.call.peerId });
  endCall();
});

$('muteCall').addEventListener('click', (e) => {
  const call = state.call;
  if (!call?.localStream) return;
  const track = call.localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  e.target.classList.toggle('is-muted', !track.enabled);
  e.target.textContent = track.enabled ? 'كتم' : 'إلغاء الكتم';
});

function openCallLayer(peerId, status, nameOverride) {
  const contact = state.contacts.find((c) => c.id === peerId);
  const name = nameOverride || contact?.displayName || 'مكالمة';

  $('callLayer').hidden = false;
  $('callAvatar').textContent = initials(name);
  $('callName').textContent = name;
  setCallStatus(status);
}

function setCallStatus(status) {
  if (state.call) state.call.status = status;
  const label = { calling: 'يتصل…', incoming: 'مكالمة واردة', active: 'جارية الآن' }[status];
  $('callStatus').textContent = label;
  $('callActionsIncoming').hidden = status !== 'incoming';
  $('callActionsActive').hidden = status !== 'active';
}

function endCall() {
  if (state.call?.pc) state.call.pc.close();
  if (state.call?.localStream) state.call.localStream.getTracks().forEach((t) => t.stop());
  state.call = null;
  $('callLayer').hidden = true;
  $('remoteAudio').srcObject = null;
  $('muteCall').classList.remove('is-muted');
  $('muteCall').textContent = 'كتم';
}

boot();

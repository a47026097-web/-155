/**
 * دردشة — سيرفر التطبيق
 * Express + Socket.IO + SQLite
 */

const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'غيّر-هذا-المفتاح-قبل-النشر';

/* ---------------------------------- قاعدة البيانات --------------------------------- */

const db = new Database(path.join(__dirname, 'dardasha.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  about         TEXT DEFAULT 'متاح',
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender_id, receiver_id, id);
`);

const q = {
  createUser: db.prepare(
    `INSERT INTO users (username, display_name, password_hash, created_at)
     VALUES (?, ?, ?, ?)`
  ),
  userByName: db.prepare(`SELECT * FROM users WHERE username = ?`),
  userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  allUsers: db.prepare(
    `SELECT id, username, display_name, about, last_seen FROM users WHERE id != ? ORDER BY display_name`
  ),
  touchSeen: db.prepare(`UPDATE users SET last_seen = ? WHERE id = ?`),

  insertMessage: db.prepare(
    `INSERT INTO messages (sender_id, receiver_id, body, created_at) VALUES (?, ?, ?, ?)`
  ),
  messageById: db.prepare(`SELECT * FROM messages WHERE id = ?`),
  conversation: db.prepare(
    `SELECT * FROM messages
     WHERE (sender_id = @me AND receiver_id = @other)
        OR (sender_id = @other AND receiver_id = @me)
     ORDER BY id ASC
     LIMIT 500`
  ),
  markRead: db.prepare(
    `UPDATE messages SET read_at = @now
     WHERE sender_id = @other AND receiver_id = @me AND read_at IS NULL`
  ),
  readIds: db.prepare(
    `SELECT id FROM messages WHERE sender_id = @other AND receiver_id = @me AND read_at IS NOT NULL`
  ),
  // آخر رسالة + عدد غير المقروء لكل محادثة
  summaries: db.prepare(`
    SELECT
      other.id AS user_id,
      (SELECT body FROM messages m
        WHERE (m.sender_id = @me AND m.receiver_id = other.id)
           OR (m.sender_id = other.id AND m.receiver_id = @me)
        ORDER BY m.id DESC LIMIT 1) AS last_body,
      (SELECT created_at FROM messages m
        WHERE (m.sender_id = @me AND m.receiver_id = other.id)
           OR (m.sender_id = other.id AND m.receiver_id = @me)
        ORDER BY m.id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages m
        WHERE m.sender_id = other.id AND m.receiver_id = @me AND m.read_at IS NULL) AS unread
    FROM users other
    WHERE other.id != @me
  `)
};

/* ------------------------------------ أدوات ------------------------------------ */

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  about: u.about,
  lastSeen: u.last_seen
});

const sign = (user) =>
  jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });

function verify(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const payload = verify(header.replace('Bearer ', ''));
  if (!payload) return res.status(401).json({ error: 'الجلسة منتهية، سجّل الدخول من جديد' });
  req.user = q.userById.get(payload.id);
  if (!req.user) return res.status(401).json({ error: 'الحساب غير موجود' });
  next();
}

/* ------------------------------------ الواجهة ----------------------------------- */

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const displayName = String(req.body.displayName || '').trim();
  const password = String(req.body.password || '');

  if (!/^[a-z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: 'اسم المستخدم: 3-20 حرف إنكليزي أو رقم أو _' });
  if (displayName.length < 2)
    return res.status(400).json({ error: 'اكتب اسمك الظاهر (حرفين على الأقل)' });
  if (password.length < 6)
    return res.status(400).json({ error: 'كلمة السر لازم 6 أحرف على الأقل' });
  if (q.userByName.get(username))
    return res.status(409).json({ error: 'اسم المستخدم محجوز، جرّب غيره' });

  const hash = bcrypt.hashSync(password, 10);
  const info = q.createUser.run(username, displayName, hash, Date.now());
  const user = q.userById.get(info.lastInsertRowid);
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = q.userByName.get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة السر غير صحيحة' });

  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

// إعدادات خوادم STUN/TURN المستخدمة لثقب الجدار الناري بين الراوترات المختلفة.
// STUN عام ومجاني ويكفي بأغلب الحالات. TURN تحتاجه بالشبكات المقيدة جداً (NAT متماثل)،
// وتقدر تضيف خادمك الخاص عبر متغيرات البيئة TURN_URL / TURN_USER / TURN_PASS.
app.get('/api/ice-config', auth, (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS
    });
  }
  res.json({ iceServers });
});

// قائمة جهات الاتصال مع آخر رسالة وعدد غير المقروء
app.get('/api/contacts', auth, (req, res) => {
  const me = req.user.id;
  const summary = new Map(q.summaries.all({ me }).map((r) => [r.user_id, r]));
  const contacts = q.allUsers.all(me).map((u) => {
    const s = summary.get(u.id) || {};
    return {
      ...publicUser(u),
      lastMessage: s.last_body || null,
      lastAt: s.last_at || null,
      unread: s.unread || 0,
      online: online.has(u.id)
    };
  });
  contacts.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  res.json({ contacts });
});

// سجل محادثة مع شخص واحد
app.get('/api/messages/:userId', auth, (req, res) => {
  const other = Number(req.params.userId);
  if (!q.userById.get(other)) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const rows = q.conversation.all({ me: req.user.id, other });
  res.json({ messages: rows.map(toMessage) });
});

const toMessage = (m) => ({
  id: m.id,
  from: m.sender_id,
  to: m.receiver_id,
  body: m.body,
  createdAt: m.created_at,
  readAt: m.read_at
});

/* ---------------------------------- الاتصال الفوري --------------------------------- */

const server = http.createServer(app);
const io = new Server(server);

/** userId -> عدد النوافذ المفتوحة */
const online = new Map();

io.use((socket, next) => {
  const payload = verify(socket.handshake.auth?.token || '');
  if (!payload) return next(new Error('unauthorized'));
  const user = q.userById.get(payload.id);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const me = socket.user.id;
  socket.join(`u:${me}`);

  online.set(me, (online.get(me) || 0) + 1);
  if (online.get(me) === 1) io.emit('presence', { userId: me, online: true });

  // إرسال رسالة
  socket.on('message:send', (data, ack) => {
    const to = Number(data?.to);
    const body = String(data?.body || '').trim().slice(0, 4000);
    if (!body || !q.userById.get(to)) return ack?.({ error: 'ما قدرنا نرسل الرسالة' });

    const info = q.insertMessage.run(me, to, body, Date.now());
    const message = toMessage(q.messageById.get(info.lastInsertRowid));

    io.to(`u:${to}`).emit('message:new', message);
    io.to(`u:${me}`).emit('message:new', message);
    ack?.({ ok: true, message });
  });

  // إشعار "يكتب الآن"
  socket.on('typing', ({ to, isTyping }) => {
    io.to(`u:${Number(to)}`).emit('typing', { from: me, isTyping: !!isTyping });
  });

  // تعليم رسائل شخص كمقروءة
  socket.on('message:read', ({ from }) => {
    const other = Number(from);
    q.markRead.run({ me, other, now: Date.now() });
    const ids = q.readIds.all({ me, other }).map((r) => r.id);
    io.to(`u:${other}`).emit('message:read', { by: me, ids });
  });

  /* --------------------------- مكالمة صوتية (WebRTC) -------------------------- */
  // السيرفر هنا يمرر الإشارة (Signaling) بس؛ الصوت نفسه يمشي مباشرة بين الجهازين
  // عبر WebRTC، ويستخدم خوادم STUN/TURN لثقب الجدار الناري بين الراوترات.

  socket.on('call:invite', ({ to }) => {
    const target = Number(to);
    if (!q.userById.get(target)) return;
    io.to(`u:${target}`).emit('call:invite', { from: me, name: socket.user.display_name });
  });

  socket.on('call:offer', ({ to, sdp }) => {
    io.to(`u:${Number(to)}`).emit('call:offer', { from: me, sdp });
  });

  socket.on('call:answer', ({ to, sdp }) => {
    io.to(`u:${Number(to)}`).emit('call:answer', { from: me, sdp });
  });

  socket.on('call:ice-candidate', ({ to, candidate }) => {
    io.to(`u:${Number(to)}`).emit('call:ice-candidate', { from: me, candidate });
  });

  socket.on('call:reject', ({ to }) => {
    io.to(`u:${Number(to)}`).emit('call:reject', { from: me });
  });

  socket.on('call:end', ({ to }) => {
    io.to(`u:${Number(to)}`).emit('call:end', { from: me });
  });

  socket.on('disconnect', () => {
    const left = (online.get(me) || 1) - 1;
    if (left <= 0) {
      online.delete(me);
      q.touchSeen.run(Date.now(), me);
      io.emit('presence', { userId: me, online: false, lastSeen: Date.now() });
      // إذا كان بمكالمة وسكّر المتصفح، خلي الطرف الثاني يعرف
      io.emit('call:end', { from: me });
    } else {
      online.set(me, left);
    }
  });
});

server.listen(PORT, () => {
  console.log(`دردشة تشتغل على http://localhost:${PORT}`);
});

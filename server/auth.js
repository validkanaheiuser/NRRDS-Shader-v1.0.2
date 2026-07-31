// Uses Node's built-in SQLite (node:sqlite) — no native module to compile,
// works on Node 22.5+ (with --experimental-sqlite) and Node 23.4+/24 without a
// flag. This avoids the better-sqlite3 prebuild/ABI headaches entirely.
const { DatabaseSync } = require('node:sqlite');
const crypto   = require('crypto');
const path     = require('path');

const DB_PATH = process.env.AUTH_DB || path.join(__dirname, 'auth.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS user_devices (
    user_id   INTEGER NOT NULL,
    device_id TEXT    NOT NULL,
    PRIMARY KEY (user_id, device_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

const SALT = process.env.AUTH_SALT || 'audio-bridge-salt-v1';

function hashPw(pw) {
  return crypto.createHmac('sha256', SALT).update(pw).digest('hex');
}

function createUser(username, password, role = 'user') {
  return db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hashPw(password), role);
}

function verifyUser(username, password) {
  return db.prepare('SELECT id, username, role FROM users WHERE username = ? AND password_hash = ?')
    .get(username, hashPw(password)) || null;
}

function createSession(userId) {
  const token    = crypto.randomBytes(32).toString('hex');
  const expires  = Math.floor(Date.now() / 1000) + 86400 * 30;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

function getSession(token) {
  if (!token) return null;
  return db.prepare(`
    SELECT s.token, s.user_id, s.expires_at, u.username, u.role
    FROM   sessions s JOIN users u ON s.user_id = u.id
    WHERE  s.token = ? AND s.expires_at > unixepoch()
  `).get(token) || null;
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function ensureAdmin() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get('admin');
  if (row.c > 0) return;
  const u = process.env.ADMIN_USER || 'admin';
  const p = process.env.ADMIN_PASS || 'admin123';
  try { createUser(u, p, 'admin'); } catch (_) {}
  console.log(`[AUTH] Admin mặc định: ${u} / ${p}`);
  if (p === 'admin123') console.warn('[AUTH] ⚠  Đổi mật khẩu admin ngay trong trang Quản trị!');
}

const getAllUsers = () =>
  db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all();

const getUserById = id =>
  db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id) || null;

const deleteUser = id =>
  db.prepare('DELETE FROM users WHERE id = ?').run(id);

const updateUserPassword = (id, pw) =>
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPw(pw), id);

const updateUserRole = (id, role) =>
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);

const getUserDevices = userId =>
  db.prepare('SELECT device_id FROM user_devices WHERE user_id = ?').all(userId).map(r => r.device_id);

function setUserDevices(userId, deviceIds) {
  const del = db.prepare('DELETE FROM user_devices WHERE user_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO user_devices (user_id, device_id) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    del.run(userId);
    for (const d of deviceIds) ins.run(userId, d);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = {
  createUser, verifyUser, createSession, getSession, deleteSession, ensureAdmin,
  getAllUsers, getUserById, deleteUser, updateUserPassword, updateUserRole,
  getUserDevices, setUserDevices,
};

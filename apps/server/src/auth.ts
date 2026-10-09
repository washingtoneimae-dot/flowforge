/** Single-admin auth: password (scrypt) + session/API tokens (SHA-256 lookup).
 *
 *  - Fresh installs and upgrades start in SETUP mode (no password set):
 *    POST /api/auth/setup sets it once. FLOWFORGE_PASSWORD env skips setup.
 *  - UI uses an httpOnly cookie; API/MCP clients use `Authorization: Bearer`.
 *  - Named long-lived API tokens exist for the local MCP server and scripts.
 *  - /hook/* stays open by design (external services can't log in) — treat
 *    webhook paths as unguessable secrets.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db } from './db.js';

const SESSION_TTL_MS = 30 * 24 * 3600_000;
const TOKEN_TTL_MS = 365 * 24 * 3600_000;

/* ---------------------------------- password ---------------------------------- */

export function hashPassword(password: string): string {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const candidate = scryptSync(String(password ?? ''), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

const getSetting = (k: string): string | null => {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(k) as { value: string } | undefined;
  return row?.value ?? null;
};

const setSetting = (k: string, v: string) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
};

/** True when neither env password nor stored hash exists. */
export function setupRequired(): boolean {
  if ((process.env.FLOWFORGE_PASSWORD ?? '').trim()) return false;
  return getSetting('password_hash') === null;
}

/** One-shot setup. Throws when unavailable (env-managed) or already set. */
export function setupPassword(password: string): void {
  if ((process.env.FLOWFORGE_PASSWORD ?? '').trim()) throw new Error('password is managed by FLOWFORGE_PASSWORD');
  if (getSetting('password_hash') !== null) throw new Error('already set up');
  setSetting('password_hash', hashPassword(password));
}

export function checkPassword(password: string): boolean {
  const env = (process.env.FLOWFORGE_PASSWORD ?? '').trim();
  if (env) {
    const a = Buffer.from(String(password ?? ''));
    const b = Buffer.from(env);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const stored = getSetting('password_hash');
  if (!stored) return false;
  return verifyPassword(password, stored);
}

export function changePassword(current: string, next: string): void {
  if ((process.env.FLOWFORGE_PASSWORD ?? '').trim()) throw new Error('password is managed by FLOWFORGE_PASSWORD');
  const stored = getSetting('password_hash');
  if (!stored || !verifyPassword(current, stored)) throw new Error('current password is wrong');
  setSetting('password_hash', hashPassword(next));
}

/* ---------------------------------- sessions ---------------------------------- */

const sha = (token: string) => createHash('sha256').update(token).digest('hex');

export interface SessionInfo {
  label: string | null;
  created_at: string;
  expires_at: string;
}

export interface ApiTokenInfo extends SessionInfo {
  /** First 12 hex chars of the token hash — a non-secret row handle for revoke. */
  id: string;
}

/** Mint a session (label null) or named API token. Returns the PLAINTEXT once. */
export function mintSession(label: string | null, ttlMs: number = SESSION_TTL_MS): { token: string; expires_at: string } {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs);
  db.prepare('INSERT INTO sessions (token_hash, label, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha(token), label, now.toISOString(), expires.toISOString());
  return { token, expires_at: expires.toISOString() };
}

export function createApiToken(label: string): { token: string; expires_at: string } {
  const name = String(label ?? '').trim().slice(0, 80);
  if (!name) throw new Error('label is required');
  return mintSession(name, TOKEN_TTL_MS);
}

/** Validate a presented token. Returns session info or null (unknown/expired). */
export function validateSession(token: string): SessionInfo | null {
  if (!token) return null;
  const row = db.prepare('SELECT label, created_at, expires_at FROM sessions WHERE token_hash=?').get(sha(token)) as
    | { label: string | null; created_at: string; expires_at: string } | undefined;
  if (!row) return null;
  if (Date.now() > Date.parse(row.expires_at)) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
    return null;
  }
  return row;
}

export function revokeSession(token: string): boolean {
  return Number(db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token)).changes) > 0;
}

/** Revoke by UI row id (hash prefix). Returns rows removed. */
export function revokeTokenById(id: string): number {
  const prefix = String(id ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{4,64}$/.test(prefix)) return 0;
  return Number(db.prepare('DELETE FROM sessions WHERE token_hash LIKE ?').run(`${prefix}%`).changes);
}

export function revokeAllSessions(): number {
  return Number(db.prepare('DELETE FROM sessions').run().changes);
}

export function listApiTokens(): ApiTokenInfo[] {
  const rows = db.prepare("SELECT token_hash, label, created_at, expires_at FROM sessions WHERE label IS NOT NULL ORDER BY created_at DESC").all() as unknown as Array<{
    token_hash: string; label: string | null; created_at: string; expires_at: string;
  }>;
  return rows.map((r) => ({ id: r.token_hash.slice(0, 12), label: r.label, created_at: r.created_at, expires_at: r.expires_at }));
}

/* ---------------------------------- throttle ---------------------------------- */

const attempts = new Map<string, { fails: number; resetAt: number }>();

/** Returns true when this IP may attempt login now (records nothing). */
export function loginAllowed(ip: string): boolean {
  const rec = attempts.get(ip);
  if (!rec) return true;
  if (Date.now() > rec.resetAt) {
    attempts.delete(ip);
    return true;
  }
  return rec.fails < 10;
}

export function recordLogin(ip: string, ok: boolean): void {
  if (ok) {
    attempts.delete(ip);
    return;
  }
  const rec = attempts.get(ip) ?? { fails: 0, resetAt: Date.now() + 5 * 60_000 };
  rec.fails += 1;
  attempts.set(ip, rec);
}

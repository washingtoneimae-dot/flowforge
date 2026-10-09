/** Credentials store: named secrets (API tokens, logins) encrypted with AES-256-GCM.
 *
 *  Agents and workflows reference credentials BY NAME — values are resolved at
 *  run time and never leave the server except inside node execution. The API
 *  only ever returns names + types. Definitions store names, so exports stay clean.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { db } from './db.js';

export const CRED_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_BYTES = 32;

/** Resolve the data key: explicit env hex wins, else a machine-local file (0600). */
export function getCredKey(repoRoot: string): Buffer {
  const env = (process.env.FLOWFORGE_CRED_KEY ?? '').trim();
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) {
      throw new Error('FLOWFORGE_CRED_KEY must be 64 hex chars (32 bytes)');
    }
    return Buffer.from(env, 'hex');
  }
  const keyPath = process.env.FLOWFORGE_CRED_KEY_FILE ?? join(repoRoot, 'data', '.credkey');
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, 'utf8').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`credential key file ${keyPath} is corrupt (want 64 hex chars)`);
    return Buffer.from(raw, 'hex');
  }
  const fresh = randomBytes(KEY_BYTES).toString('hex');
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, fresh + '\n', { mode: 0o600 });
  return Buffer.from(fresh, 'hex');
}

/** v1.<base64(iv 12B | tag 16B | ciphertext)> */
export function encryptFields(key: Buffer, fields: Record<string, unknown>): string {
  if (key.length !== KEY_BYTES) throw new Error('credential key must be 32 bytes');
  const plain = JSON.stringify(fields ?? {});
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${Buffer.concat([iv, tag, ct]).toString('base64')}`;
}

export function decryptFields(key: Buffer, payload: string): Record<string, unknown> {
  if (key.length !== KEY_BYTES) throw new Error('credential key must be 32 bytes');
  if (typeof payload !== 'string' || !payload.startsWith('v1.')) throw new Error('unknown credential payload version');
  const raw = Buffer.from(payload.slice(3), 'base64');
  if (raw.length < 28) throw new Error('credential payload too short');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    const parsed: unknown = JSON.parse(plain);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad fields');
    return parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as Error).message === 'bad fields') throw e;
    throw new Error('cannot decrypt credential (wrong key or tampered data)');
  }
}

export interface CredentialMeta {
  name: string;
  type: string;
  created_at: string;
  updated_at: string;
}

export function validateCredentialInput(body: unknown): { name: string; type: string; fields: Record<string, unknown> } {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const b = body as any;
  const name = String(b.name ?? '');
  if (!CRED_NAME_RE.test(name)) throw new Error('name must match [A-Za-z0-9_-]{1,64}');
  const type = String(b.type ?? 'token').trim().slice(0, 32) || 'token';
  const fields = b.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
    throw new Error('fields must be a non-empty object');
  }
  return { name, type, fields: fields as Record<string, unknown> };
}

export function listCredentials(): CredentialMeta[] {
  return db.prepare('SELECT name, type, created_at, updated_at FROM credentials ORDER BY name').all() as unknown as CredentialMeta[];
}

export function insertCredential(name: string, type: string, enc: string): CredentialMeta {
  const exists = db.prepare('SELECT name FROM credentials WHERE name=?').get(name);
  if (exists) throw new Error(`credential "${name}" already exists`);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO credentials (name, type, data, created_at, updated_at) VALUES (?,?,?,?,?)').run(name, type, enc, now, now);
  return db.prepare('SELECT name, type, created_at, updated_at FROM credentials WHERE name=?').get(name) as unknown as CredentialMeta;
}

export function updateCredential(name: string, type: string | undefined, enc: string | undefined): CredentialMeta | null {
  const row = db.prepare('SELECT type, data FROM credentials WHERE name=?').get(name) as { type: string; data: string } | undefined;
  if (!row) return null;
  const now = new Date().toISOString();
  db.prepare('UPDATE credentials SET type=?, data=?, updated_at=? WHERE name=?')
    .run(type ?? row.type, enc ?? row.data, now, name);
  return db.prepare('SELECT name, type, created_at, updated_at FROM credentials WHERE name=?').get(name) as unknown as CredentialMeta;
}

export function deleteCredential(name: string): boolean {
  return db.prepare('DELETE FROM credentials WHERE name=?').run(name).changes > 0;
}

export function getCredentialFields(key: Buffer, name: string): Record<string, unknown> {
  const row = db.prepare('SELECT data FROM credentials WHERE name=?').get(name) as { data: string } | undefined;
  if (!row) throw new Error(`credential "${name}" not found — create it in Settings → Credentials`);
  return decryptFields(key, row.data);
}

export interface CredRefNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
}

type DefResolver = (type: string) => { properties?: Array<{ key: string; type: string }> } | undefined;

/** Replace `credential`-type params (stored names) with secret field objects.
 *  Returns new node objects plus the referenced names for audit.
 *  The stored definition keeps names only. */
export function resolveCredentialRefs(
  nodes: CredRefNode[],
  resolveDef: DefResolver,
  getFields: (name: string) => Record<string, unknown>,
): { nodes: CredRefNode[]; used: string[] } {
  const used: string[] = [];
  const out = nodes.map((n) => {
    const def = resolveDef(n.type);
    const credKeys = new Set((def?.properties ?? []).filter((p) => p.type === 'credential').map((p) => p.key));
    if (credKeys.size === 0) return n;
    const params = { ...n.params };
    for (const k of credKeys) {
      const v = params[k];
      if (typeof v !== 'string' || !v) continue; // unset — node decides (usually: no auth)
      params[k] = getFields(v);
      if (!used.includes(v)) used.push(v);
    }
    return { ...n, params };
  });
  return { nodes: out, used };
}

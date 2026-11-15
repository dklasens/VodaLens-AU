'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createCipheriv, createDecipheriv, randomBytes, createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
class Store {
  constructor({ filename, key, clock = Date.now }) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte vault key is required.');
    this.key = key; this.clock = clock;
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(fs.readFileSync(path.join(__dirname, '../migrations/001-foundation.sql'), 'utf8'));
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,?)').run(this.clock());
  }
  seal(value, context) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map(x => x.toString('base64url')).join('.');
  }
  open(value, context) {
    const parts = value.split('.').map(x => Buffer.from(x, 'base64url'));
    if (parts.length !== 3) throw new Error('Invalid encrypted record.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, parts[0]);
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(parts[1]);
    return JSON.parse(Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString('utf8'));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveTransaction({ state, ownerId, stream, verifier, expiresAt }) {
    this.db.prepare('DELETE FROM oauth_transactions WHERE expires_at < ?').run(this.clock());
    this.db.prepare('INSERT INTO oauth_transactions VALUES(?,?,?,?,?)').run(hash(state), ownerId, stream, this.seal({ verifier }, `pkce:${ownerId}:${hash(state)}`), expiresAt);
  }
  consumeTransaction(state) {
    return this.transaction(() => {
      const key = hash(state), row = this.db.prepare('SELECT * FROM oauth_transactions WHERE state_hash=?').get(key);
      if (!row) return null;
      this.db.prepare('DELETE FROM oauth_transactions WHERE state_hash=?').run(key);
      if (row.expires_at <= this.clock()) return null;
      return { ownerId: row.owner_id, stream: row.stream, ...this.open(row.verifier_ciphertext, `pkce:${row.owner_id}:${key}`) };
    });
  }
  saveConnection(ownerId, tokens, proof) {
    this.db.prepare('INSERT INTO connections VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET tokens_ciphertext=excluded.tokens_ciphertext,proof_json=excluded.proof_json,updated_at=excluded.updated_at').run(ownerId, this.seal(tokens, `tokens:${ownerId}`), JSON.stringify(proof), this.clock());
  }
  connection(ownerId) {
    const row = this.db.prepare('SELECT * FROM connections WHERE owner_id=?').get(ownerId);
    return row ? { tokens: this.open(row.tokens_ciphertext, `tokens:${ownerId}`), proof: JSON.parse(row.proof_json), updatedAt: row.updated_at } : null;
  }
  removeConnection(ownerId) { this.db.prepare('DELETE FROM connections WHERE owner_id=?').run(ownerId); }
  proof(ownerId) {
    const row = this.db.prepare('SELECT proof_json,updated_at FROM connections WHERE owner_id=?').get(ownerId);
    return row ? { ...JSON.parse(row.proof_json), updatedAt: row.updated_at } : null;
  }
  saveHistory(ownerId, line) {
    this.transaction(() => {
      // A newer partial response must invalidate older complete coverage inside
      // its window. Keep the unaffected left/right fragments of older windows.
      const windows = this.db.prepare('SELECT * FROM usage_windows WHERE owner_id=? AND service=? AND start_date<? AND end_date_exclusive>?').all(ownerId, line.phone, line.range.end, line.range.start);
      const writeWindow = this.db.prepare('INSERT INTO usage_windows VALUES(?,?,?,?,?,?)');
      for (const window of windows) {
        this.db.prepare('DELETE FROM usage_windows WHERE owner_id=? AND service=? AND start_date=? AND end_date_exclusive=?').run(ownerId, line.phone, window.start_date, window.end_date_exclusive);
        if (window.start_date < line.range.start) writeWindow.run(ownerId, line.phone, window.start_date, line.range.start, window.fetched_at, window.skipped);
        if (window.end_date_exclusive > line.range.end) writeWindow.run(ownerId, line.phone, line.range.end, window.end_date_exclusive, window.fetched_at, window.skipped);
      }
      if (!line.skipped) this.db.prepare('DELETE FROM usage_sessions WHERE owner_id=? AND service=? AND recorded_date>=? AND recorded_date<?').run(ownerId, line.phone, line.range.start, line.range.end);
      const insert = this.db.prepare('INSERT INTO usage_sessions VALUES(?,?,?,?,?) ON CONFLICT(owner_id,service,record_id) DO UPDATE SET recorded_date=excluded.recorded_date,record_json=excluded.record_json');
      for (const record of line.records) insert.run(ownerId, line.phone, record.id, record.date, JSON.stringify(record));
      writeWindow.run(ownerId, line.phone, line.range.start, line.range.end, this.clock(), line.skipped);
    });
  }
  history(ownerId, service, start, end) {
    const records = this.db.prepare('SELECT record_json FROM usage_sessions WHERE owner_id=? AND service=? AND recorded_date>=? AND recorded_date<? ORDER BY recorded_date,record_id').all(ownerId, service, start, end).map(row => JSON.parse(row.record_json));
    const windows = this.db.prepare('SELECT start_date AS start,end_date_exclusive AS end,fetched_at AS fetchedAt,skipped FROM usage_windows WHERE owner_id=? AND service=? AND start_date<? AND end_date_exclusive>? ORDER BY start_date').all(ownerId, service, end, start);
    return { records, windows };
  }
  close() { this.db.close(); }
}
module.exports = { Store, hash };

import fs from "node:fs";

import path from "node:path";

import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";

import { schemaStatements, migrationStatements } from "./schema.js";

import { logger, nowMs } from "./util.js";

export class PresenceDB {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = null;
    this.queue = [];
    this.flushing = false;
    this.flushTimer = null;
    this.spoolDir = path.resolve(cfg.spoolDir || "./data");
    this.spoolPath = path.join(this.spoolDir, "spool.ndjson");
  }
  async init() {
    fs.mkdirSync(this.spoolDir, {
      recursive: true
    });
    const remote = Boolean(this.cfg.db.url && this.cfg.db.url.trim());
    let url;
    if (remote) {
      url = this.cfg.db.url;
    } else {
      const abs = path.resolve(this.cfg.db.localFile);
      fs.mkdirSync(path.dirname(abs), {
        recursive: true
      });
      url = pathToFileURL(abs).href;
    }
    this.client = createClient({
      url,
      authToken: remote ? this.cfg.db.authToken || undefined : undefined
    });
    await this.client.execute("SELECT 1");
    for (const statement of schemaStatements) {
      await this.client.execute(statement);
    }
    for (const statement of migrationStatements) {
      try {
        await this.client.execute(statement);
      } catch {}
    }
    this._loadSpool();
    logger.info(`db ready (${remote ? "turso/libsql remote" : "local file"})`);
  }
  async _exec(sql, args = []) {
    return this.client.execute({
      sql,
      args
    });
  }
  async run(sql, args = []) {
    try {
      return await this._exec(sql, args);
    } catch (err) {
      logger.warn("db write failed, spooling:", err.message);
      this._spool({
        sql,
        args
      });
      return null;
    }
  }
  async query(sql, args = []) {
    try {
      const result = await this._exec(sql, args);
      return result.rows || [];
    } catch (err) {
      logger.warn("db query failed:", err.message);
      return [];
    }
  }
  _spool(operation) {
    this.queue.push(operation);
    this._persistSpool();
  }
  _persistSpool() {
    try {
      const tmp = `${this.spoolPath}.tmp`;
      const body = this.queue.map(entry => JSON.stringify(entry)).join("\n");
      fs.writeFileSync(tmp, this.queue.length ? `${body}\n` : "");
      fs.renameSync(tmp, this.spoolPath);
    } catch (err) {
      logger.error("failed to persist spool:", err.message);
    }
  }
  _loadSpool() {
    try {
      if (!fs.existsSync(this.spoolPath)) return;
      const raw = fs.readFileSync(this.spoolPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          this.queue.push(JSON.parse(line));
        } catch {}
      }
      if (this.queue.length) logger.info(`loaded ${this.queue.length} spooled db operation(s)`);
    } catch (err) {
      logger.warn("failed to read spool:", err.message);
    }
  }
  startFlusher() {
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, 15e3);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }
  async flush() {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const operation = this.queue[0];
        try {
          await this._exec(operation.sql, operation.args || []);
          this.queue.shift();
        } catch (err) {
          logger.warn("spool flush failed, will retry:", err.message);
          break;
        }
      }
      this._persistSpool();
    } finally {
      this.flushing = false;
    }
  }
  async close() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush().catch(() => {});
    try {
      await (this.client?.close?.());
    } catch {}
  }
  async upsertUser(userId, {username, globalName} = {}) {
    const now = nowMs();
    await this.run(`INSERT INTO users (user_id, username, global_name, first_seen, tracked, added_by, note)\n       VALUES (?, ?, ?, ?, 0, NULL, NULL)\n       ON CONFLICT(user_id) DO UPDATE SET\n         username = COALESCE(excluded.username, users.username),\n         global_name = COALESCE(excluded.global_name, users.global_name)`, [ userId, username ?? null, globalName ?? null, now ]);
  }
  async setTracked(userId, tracked, actor, {username, globalName, channelId} = {}) {
    const now = nowMs();
    await this.run(`INSERT INTO users (user_id, username, global_name, first_seen, tracked, added_by, notify_channel_id, note)\n       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)\n       ON CONFLICT(user_id) DO UPDATE SET\n         tracked = excluded.tracked,\n         added_by = COALESCE(excluded.added_by, users.added_by),\n         username = COALESCE(excluded.username, users.username),\n         global_name = COALESCE(excluded.global_name, users.global_name),\n         notify_channel_id = COALESCE(excluded.notify_channel_id, users.notify_channel_id)`, [ userId, username ?? null, globalName ?? null, now, tracked ? 1 : 0, actor ?? null, channelId ?? null ]);
  }
  async setNotifyChannel(userId, channelId) {
    await this.run(`UPDATE users SET notify_channel_id = ? WHERE user_id = ?`, [ channelId, userId ]);
  }
  async setChannelWebhook(channelId, webhookUrl) {
    await this.run(`INSERT INTO channel_webhooks (channel_id, webhook_url, created_at)\n       VALUES (?, ?, ?)\n       ON CONFLICT(channel_id) DO UPDATE SET webhook_url = excluded.webhook_url`, [ channelId, webhookUrl, nowMs() ]);
  }
  async getChannelWebhook(channelId) {
    const rows = await this.query(`SELECT webhook_url FROM channel_webhooks WHERE channel_id = ?`, [ channelId ]);
    return rows[0]?.webhook_url ?? null;
  }
  async logAction(userId, action, actor) {
    await this.run(`INSERT INTO tracking_log (user_id, action, actor, at) VALUES (?, ?, ?, ?)`, [ userId, action, actor ?? null, nowMs() ]);
  }
  async addEvent(userId, event, prevStatus, newStatus, occurredAt, durationS = null) {
    await this.run(`INSERT INTO events (user_id, event, prev_status, new_status, occurred_at, duration_s)\n       VALUES (?, ?, ?, ?, ?, ?)`, [ userId, event, prevStatus ?? null, newStatus ?? null, occurredAt, durationS ]);
  }
  async ensureOpenSession(userId, startedAt) {
    const rows = await this.query(`SELECT id FROM sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`, [ userId ]);
    if (rows.length > 0) return false;
    await this.run(`INSERT INTO sessions (user_id, started_at, ended_at, duration_s) VALUES (?, ?, NULL, NULL)`, [ userId, startedAt ]);
    return true;
  }
  async closeSession(userId, endedAt) {
    const rows = await this.query(`SELECT id, started_at FROM sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`, [ userId ]);
    if (rows.length === 0) return null;
    const {id, started_at: startedAt} = rows[0];
    const durationS = Math.max(0, Math.floor((endedAt - Number(startedAt)) / 1e3));
    await this.run(`UPDATE sessions SET ended_at = ?, duration_s = ? WHERE id = ?`, [ endedAt, durationS, id ]);
    return durationS;
  }
  async getTracked() {
    return this.query(`SELECT user_id, username, global_name, first_seen, added_by, notify_channel_id\n       FROM users WHERE tracked = 1 ORDER BY first_seen ASC`);
  }
  async getHistory(userId, limit = 10) {
    const rows = await this.query(`SELECT event, prev_status, new_status, occurred_at, duration_s\n       FROM events WHERE user_id = ?\n       ORDER BY occurred_at DESC LIMIT ?`, [ userId, limit ]);
    return rows.reverse();
  }
  async getStats(userId) {
    const totals = await this.query(`SELECT COUNT(*) AS sessions,\n              COALESCE(SUM(duration_s), 0) AS total_s,\n              COALESCE(AVG(duration_s), 0) AS avg_s,\n              COALESCE(MAX(duration_s), 0) AS max_s\n       FROM sessions WHERE user_id = ? AND ended_at IS NOT NULL`, [ userId ]);
    const last = await this.query(`SELECT event, occurred_at FROM events WHERE user_id = ? ORDER BY occurred_at DESC LIMIT 1`, [ userId ]);
    const first = await this.query(`SELECT first_seen FROM users WHERE user_id = ?`, [ userId ]);
    const row = totals[0] || {};
    return {
      sessions: Number(row.sessions ?? 0),
      totalS: Number(row.total_s ?? 0),
      avgS: Number(row.avg_s ?? 0),
      maxS: Number(row.max_s ?? 0),
      last: last[0] ?? null,
      firstSeen: first[0] ? Number(first[0].first_seen) : null
    };
  }
  async getExportRows(userId) {
    const base = `SELECT e.user_id,\n                         COALESCE(u.global_name, u.username, e.user_id) AS name,\n                         e.event, e.prev_status, e.new_status, e.occurred_at, e.duration_s\n                  FROM events e\n                  LEFT JOIN users u ON u.user_id = e.user_id`;
    if (userId) {
      return this.query(`${base} WHERE e.user_id = ? ORDER BY e.occurred_at ASC`, [ userId ]);
    }
    return this.query(`${base} ORDER BY e.occurred_at ASC`);
  }
}

import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { logger } from "./util.js";

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
};

const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15
};

const DEFAULT_INTENTS = INTENTS.GUILDS | INTENTS.GUILD_MEMBERS | INTENTS.GUILD_PRESENCES | INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT;

const FATAL_CLOSE_CODES = new Set([ 4004, 4010, 4011, 4012, 4013, 4014 ]);

export class Gateway extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.socket = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.user = null;
    this.heartbeatTimer = null;
    this.heartbeatTimeout = null;
    this.acked = true;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    this.intents = Number.isFinite(cfg.intentsOverride) ? cfg.intentsOverride : DEFAULT_INTENTS;
  }
  connect() {
    const url = this.sessionId && this.resumeUrl ? `${this.resumeUrl.replace(/\/$/, "")}/?v=10&encoding=json` : this.cfg.gatewayUrl;
    logger.info(`gateway connecting (${this.sessionId ? "resume" : "fresh"})`);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on("open", () => logger.info("gateway socket open"));
    socket.on("message", data => this._onMessage(data));
    socket.on("close", (code, reason) => this._onClose(code, reason.toString()));
    socket.on("error", err => logger.warn("gateway socket error:", err.message));
  }
  _send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      logger.warn("gateway send failed:", err.message);
      return false;
    }
  }
  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const {op, d, s, t} = msg;
    if (typeof s === "number") this.seq = s;
    switch (op) {
     case OP.HELLO:
      {
        const interval = Number(d?.heartbeat_interval) || 41250;
        this._startHeartbeat(interval);
        if (this.sessionId && this.seq != null) {
          logger.info("gateway resuming session");
          this._send({
            op: OP.RESUME,
            d: {
              token: this.cfg.token,
              session_id: this.sessionId,
              seq: this.seq
            }
          });
        } else {
          logger.info("gateway identifying");
          this._identify();
        }
        break;
      }

     case OP.HEARTBEAT_ACK:
      this.acked = true;
      break;

     case OP.HEARTBEAT:
      this._heartbeat();
      break;

     case OP.RECONNECT:
      logger.info("gateway requested reconnect");
      this._reconnect();
      break;

     case OP.INVALID_SESSION:
      {
        const resumable = d === true;
        logger.warn(`invalid session (resumable=${resumable})`);
        if (!resumable) {
          this.sessionId = null;
          this.seq = null;
          this.resumeUrl = null;
        }
        setTimeout(() => this._reconnect(), 1e3 + Math.random() * 4e3);
        break;
      }

     case OP.DISPATCH:
      {
        if (t === "READY") {
          this.sessionId = d?.session_id ?? null;
          this.resumeUrl = d?.resume_gateway_url ?? null;
          this.user = d?.user ?? null;
          this.reconnectAttempts = 0;
        } else if (t === "RESUMED") {
          this.reconnectAttempts = 0;
        }
        this.emit(t, d);
        break;
      }

     default:
      break;
    }
  }
  _identify() {
    this._send({
      op: OP.IDENTIFY,
      d: {
        token: this.cfg.token,
        capabilities: 253,
        properties: {
          os: "Windows",
          browser: "Chrome",
          device: "",
          system_locale: "en-US",
          browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          browser_version: "124.0.0.0",
          os_version: "10",
          referrer: "",
          referring_domain: "",
          referrer_current: "",
          referring_domain_current: "",
          release_channel: "stable",
          client_build_number: 3e5,
          client_event_source: null
        },
        presence: {
          status: this.cfg.presenceStatus,
          since: 0,
          activities: [],
          afk: false
        },
        compress: false,
        intents: this.intents
      }
    });
  }
  _startHeartbeat(interval) {
    this._clearHeartbeat();
    const jitter = Math.random() * interval;
    this.heartbeatTimeout = setTimeout(() => {
      this._heartbeat();
      this.heartbeatTimer = setInterval(() => this._heartbeat(), interval);
      if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    }, jitter);
    if (this.heartbeatTimeout.unref) this.heartbeatTimeout.unref();
  }
  _heartbeat() {
    if (!this.acked) {
      logger.warn("heartbeat not acknowledged, reconnecting");
      this._reconnect();
      return;
    }
    this.acked = false;
    this._send({
      op: OP.HEARTBEAT,
      d: this.seq
    });
  }
  _clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    this.heartbeatTimer = null;
    this.heartbeatTimeout = null;
  }
  _onClose(code, reason) {
    this._clearHeartbeat();
    if (FATAL_CLOSE_CODES.has(code)) {
      logger.error(`fatal gateway close ${code}: ${reason}`);
      this.emit("fatal", {
        code,
        reason
      });
      return;
    }
    logger.warn(`gateway closed (${code}) ${reason}`.trim());
    this._reconnect();
  }
  _reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this._clearHeartbeat();
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.close();
      } catch {}
      this.socket = null;
    }
    this.reconnectAttempts += 1;
    const base = Math.min(3e4, 1e3 * 2 ** Math.min(this.reconnectAttempts, 5));
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    logger.info(`gateway reconnecting in ${delay}ms`);
    const timer = setTimeout(() => {
      this.reconnecting = false;
      this.connect();
    }, delay);
    if (timer.unref) timer.unref();
  }
  close() {
    this._clearHeartbeat();
    if (this.socket) {
      try {
        this.socket.removeAllListeners();
        this.socket.close();
      } catch {}
      this.socket = null;
    }
  }
}

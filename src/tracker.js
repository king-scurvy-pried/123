import { logger, discordTimestamp, formatDuration, nowMs, escapeMd } from "./util.js";

export class Tracker {
  constructor({config, db, notifier}) {
    this.config = config;
    this.db = db;
    this.notifier = notifier;
    this.self = null;
    this.tracked = new Set;
    this.trackedChannels = new Map;
    this.guilds = new Set;
    this.memberNames = new Map;
    this.presence = new Map;
    this.state = new Map;
  }
  async init() {
    const rows = await this.db.getTracked();
    for (const row of rows) {
      this.tracked.add(row.user_id);
      if (row.notify_channel_id) this.trackedChannels.set(row.user_id, row.notify_channel_id);
    }
    logger.info(`loaded ${this.tracked.size} tracked user(s)`);
  }
  setSelf(user) {
    this.self = user;
  }
  knowsUser(userId) {
    return this.presence.has(userId) || this.memberNames.has(userId);
  }
  displayName(userId) {
    return this.memberNames.get(userId) || `user ${userId}`;
  }
  currentStatus(userId) {
    const raw = this.presence.get(userId);
    if (!raw) return "unknown";
    return raw === "offline" ? "offline" : "online";
  }
  async onReady(payload) {
    if (Array.isArray(payload?.guilds)) {
      for (const guild of payload.guilds) {
        if (guild?.id) this.guilds.add(guild.id);
      }
    }
    logger.info(`session ready as ${this.self?.username ?? "unknown"}`);
  }
  onGuildCreate(guild) {
    if (!guild?.id) return;
    this.guilds.add(guild.id);
    if (Array.isArray(guild.members)) {
      for (const member of guild.members) {
        const user = member?.user;
        if (!user?.id) continue;
        const name = user.global_name || user.username;
        if (name) this.memberNames.set(user.id, name);
      }
    }
    if (Array.isArray(guild.presences)) {
      for (const presence of guild.presences) {
        const userId = presence?.user?.id;
        if (!userId) continue;
        const status = presence.status || "offline";
        const name = presence.user.global_name || presence.user.username;
        if (name) this.memberNames.set(userId, name);
        this.presence.set(userId, status);
        if (this.tracked.has(userId) && !this.state.has(userId)) {
          this._seed(userId, status).catch(err => logger.warn("seed failed:", err.message));
        }
      }
    }
  }
  onPresenceUpdate(payload) {
    const userId = payload?.user?.id;
    if (!userId) return;
    const status = payload.status || "offline";
    const name = payload.user.global_name || payload.user.username;
    if (name) this.memberNames.set(userId, name);
    this.presence.set(userId, status);
    if (!this.tracked.has(userId)) return;
    const state = this.state.get(userId);
    if (!state) {
      this._seed(userId, status).catch(err => logger.warn("seed failed:", err.message));
      return;
    }
    this._handleStatus(userId, status, state);
  }
  async _seed(userId, status) {
    const category = status === "offline" ? "offline" : "online";
    this.state.set(userId, {
      currentRaw: status,
      lastRaw: status,
      lastCategory: category,
      boundaryPrevRaw: null,
      pendingCategory: category,
      notifyChannelId: this.trackedChannels.get(userId) || this.config.defaultChannelId,
      timer: null
    });
    if (category === "online") {
      await this.db.ensureOpenSession(userId, nowMs());
    }
  }
  _handleStatus(userId, status, state) {
    const category = status === "offline" ? "offline" : "online";
    if (state.timer == null && category === state.lastCategory) {
      state.currentRaw = status;
      state.lastRaw = status;
      return;
    }
    if (state.timer == null) {
      state.boundaryPrevRaw = state.lastRaw;
      state.pendingCategory = category;
      state.currentRaw = status;
      state.timer = setTimeout(() => this._commit(userId).catch(err => logger.warn("commit failed:", err.message)), this.config.debounceMs);
      if (state.timer.unref) state.timer.unref();
      return;
    }
    state.pendingCategory = category;
    state.currentRaw = status;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => this._commit(userId).catch(err => logger.warn("commit failed:", err.message)), this.config.debounceMs);
    if (state.timer.unref) state.timer.unref();
  }
  async _commit(userId) {
    const state = this.state.get(userId);
    if (!state) return;
    state.timer = null;
    const target = state.pendingCategory;
    const newRaw = state.currentRaw;
    if (target === state.lastCategory) {
      state.lastRaw = newRaw;
      state.boundaryPrevRaw = null;
      return;
    }
    const prevRaw = state.boundaryPrevRaw ?? state.lastRaw;
    const at = nowMs();
    const channelId = state.notifyChannelId || this.config.defaultChannelId;
    if (target === "online") {
      await this.db.addEvent(userId, "online", prevRaw, newRaw, at, null);
      await this.db.ensureOpenSession(userId, at);
      await this.notifier.send(this._onlineMessage(userId, at), channelId);
    } else {
      const durationS = await this.db.closeSession(userId, at);
      await this.db.addEvent(userId, "offline", prevRaw, newRaw, at, durationS);
      await this.notifier.send(this._offlineMessage(userId, at, durationS), channelId);
    }
    state.lastCategory = target;
    state.lastRaw = newRaw;
    state.boundaryPrevRaw = null;
  }
  _onlineMessage(userId, at) {
    const name = escapeMd(this.displayName(userId));
    return `🟢 **${name}** came online — ${discordTimestamp(at, "t")} (${discordTimestamp(at, "R")})`;
  }
  _offlineMessage(userId, at, durationS) {
    const name = escapeMd(this.displayName(userId));
    const duration = durationS != null ? ` — was on **${formatDuration(durationS * 1e3)}**` : "";
    return `⚫ **${name}** went offline — ${discordTimestamp(at, "t")}${duration}`;
  }
  channelFor(userId) {
    return this.trackedChannels.get(userId) || this.config.defaultChannelId || null;
  }
  async track(userId, actor, meta = {}) {
    const channelId = meta.channelId || this.config.defaultChannelId || null;
    await this.db.setTracked(userId, true, actor, {
      ...meta,
      channelId
    });
    await this.db.logAction(userId, "track", actor);
    this.tracked.add(userId);
    if (channelId) this.trackedChannels.set(userId, channelId);
    if (meta.name) this.memberNames.set(userId, meta.name);
    const knownStatus = this.presence.get(userId);
    if (knownStatus && !this.state.has(userId)) {
      await this._seed(userId, knownStatus);
    }
    const state = this.state.get(userId);
    if (state && channelId) state.notifyChannelId = channelId;
  }
  async setChannel(userId, channelId, actor) {
    await this.db.setNotifyChannel(userId, channelId);
    await this.db.logAction(userId, `route:${channelId}`, actor);
    this.trackedChannels.set(userId, channelId);
    const state = this.state.get(userId);
    if (state) state.notifyChannelId = channelId;
  }
  async untrack(userId, actor) {
    await this.db.setTracked(userId, false, actor);
    await this.db.logAction(userId, "untrack", actor);
    this.tracked.delete(userId);
    this.trackedChannels.delete(userId);
    const state = this.state.get(userId);
    if (state?.timer) clearTimeout(state.timer);
    this.state.delete(userId);
    await this.db.closeSession(userId, nowMs());
  }
}

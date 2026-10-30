import { isSnowflake, discordTimestamp, formatDuration, logger, truncate } from "./util.js";

export class CommandHandler {
  constructor({config, db, tracker, notifier}) {
    this.config = config;
    this.db = db;
    this.tracker = tracker;
    this.notifier = notifier;
    this.controlChannels = new Set(config.controlChannelIds);
  }
  _isAllowed(authorId) {
    if (this.config.allowedUserIds.length > 0) {
      return this.config.allowedUserIds.includes(authorId);
    }
    return Boolean(this.tracker.self) && authorId === this.tracker.self.id;
  }
  _isControlChannel(channelId) {
    if (this.controlChannels.size === 0) return true;
    return this.controlChannels.has(channelId);
  }
  async onMessage(msg) {
    if (!msg || !this._isControlChannel(msg.channel_id)) return;
    if (msg.webhook_id) return;
    if (!msg.author || msg.author.bot) return;
    if (!this.tracker.self) return;
    if (msg.author.id === this.tracker.self.id) return;
    if (!this._isAllowed(msg.author.id)) return;
    const content = (msg.content || "").trim();
    if (!content) return;
    const parts = content.split(/\s+/);
    const command = parts[0].toLowerCase();
    try {
      if (isSnowflake(command)) return await this._track(command, msg, parts[1]);
      switch (command) {
       case "track":
        return await this._track(parts[1], msg, parts[2]);

       case "untrack":
        return await this._untrack(parts[1], msg);

       case "move":
       case "route":
        return await this._move(parts[1], parts[2], msg);

       case "setwebhook":
        return await this._setWebhook(parts[1], msg);

       case "list":
        return await this._list();

       case "history":
        return await this._history(parts[1], parts[2]);

       case "stats":
        return await this._stats(parts[1]);

       case "status":
        return await this._status(parts[1]);

       case "export":
        return await this._export(parts[1]);

       case "help":
       case "commands":
        return this._send(this._helpText(), msg.channel_id);

       default:
        return this._send(`unknown command \`${truncate(command, 40)}\`. type \`help\`.`, msg.channel_id);
      }
    } catch (err) {
      logger.error("command failed:", err);
      return this._send(`error running \`${truncate(command, 40)}\`: ${truncate(err.message, 200)}`, msg.channel_id);
    }
  }
  _send(text, channelId) {
    return this.notifier.send(text, channelId);
  }
  _helpText() {
    return [ "**presence tracker commands**", "`<id>` or `track <id>` — track a user, notifications go to this channel", "`track <id> <channel_id>` — track and route to a specific channel", "`move <id> <channel_id>` — re-route an already tracked user", "`untrack <id>` — stop tracking", "`setwebhook <url>` — use this channel's webhook for its notifications", "`list` — tracked users + channels + status", "`history <id> [n]` — recent online/offline events", "`stats <id>` — total time, sessions, last seen", "`status <id>` — current status + bound channel", "`export <id>` | `export all` — CSV dump", "`help` — this message" ].join("\n");
  }
  async _track(userId, msg, channelArg) {
    if (!isSnowflake(userId)) {
      return this._send("usage: paste a discord user id, or `track <id> [channel_id]`", msg.channel_id);
    }
    if (channelArg && !isSnowflake(channelArg)) {
      return this._send("channel must be a discord channel id.", msg.channel_id);
    }
    const channelId = channelArg || msg.channel_id;
    if (this.tracker.tracked.has(userId)) {
      await this.tracker.setChannel(userId, channelId, msg.author.id);
      return this._send(`<@${userId}> now posts to <#${channelId}>.`, msg.channel_id);
    }
    const known = this.tracker.knowsUser(userId);
    await this.tracker.track(userId, msg.author.id, {
      channelId
    });
    const name = this.tracker.displayName(userId);
    const note = known ? "" : "\n⚠️ not seen in a shared server yet — presence will only arrive if you share a guild.";
    return this._send(`now tracking **${name}** (<@${userId}>) → <#${channelId}>.${note}`, msg.channel_id);
  }
  async _untrack(userId, msg) {
    if (!isSnowflake(userId)) {
      return this._send("usage: `untrack <id>`", msg.channel_id);
    }
    if (!this.tracker.tracked.has(userId)) {
      return this._send(`not tracking <@${userId}>.`, msg.channel_id);
    }
    await this.tracker.untrack(userId, msg.author.id);
    return this._send(`stopped tracking <@${userId}>.`, msg.channel_id);
  }
  async _move(userId, channelId, msg) {
    if (!isSnowflake(userId) || !isSnowflake(channelId)) {
      return this._send("usage: `move <id> <channel_id>`", msg.channel_id);
    }
    if (!this.tracker.tracked.has(userId)) {
      return this._send(`not tracking <@${userId}>.`, msg.channel_id);
    }
    await this.tracker.setChannel(userId, channelId, msg.author.id);
    return this._send(`<@${userId}> notifications now go to <#${channelId}>.`, msg.channel_id);
  }
  async _setWebhook(url, msg) {
    const valid = /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\//.test(url || "");
    if (!valid) {
      return this._send("usage: `setwebhook <discord webhook url>`", msg.channel_id);
    }
    await this.notifier.setChannelWebhook(msg.channel_id, url);
    return this._send(`webhook registered for <#${msg.channel_id}>.`, msg.channel_id);
  }
  async _list() {
    const rows = await this.db.getTracked();
    if (rows.length === 0) return this._send("not tracking anyone yet.");
    const lines = rows.map(row => {
      const name = row.global_name || row.username || `user ${row.user_id}`;
      const status = this.tracker.currentStatus(row.user_id);
      const channel = row.notify_channel_id ? `<#${row.notify_channel_id}>` : "default";
      const firstSeen = row.first_seen ? ` — since ${discordTimestamp(Number(row.first_seen), "d")}` : "";
      return `• **${name}** (<@${row.user_id}>) — \`${status}\` → ${channel}${firstSeen}`;
    });
    return this._send(`**tracking ${rows.length} user(s)**\n${lines.join("\n")}`);
  }
  async _history(userId, limitRaw) {
    if (!isSnowflake(userId)) {
      return this._send("usage: `history <id> [n]`");
    }
    const limit = Math.min(Math.max(Number(limitRaw) || 10, 1), 50);
    const rows = await this.db.getHistory(userId, limit);
    if (rows.length === 0) return this._send(`no events recorded for <@${userId}> yet.`);
    const lines = rows.map(row => {
      const at = discordTimestamp(Number(row.occurred_at), "f");
      const duration = row.event === "offline" && row.duration_s != null ? ` (${formatDuration(Number(row.duration_s) * 1e3)})` : "";
      return `${at} — **${row.event}**${duration}`;
    });
    return this._send(`**history for <@${userId}>** (${rows.length})\n${lines.join("\n")}`);
  }
  async _stats(userId) {
    if (!isSnowflake(userId)) {
      return this._send("usage: `stats <id>`");
    }
    const stats = await this.db.getStats(userId);
    const lines = [ `**stats for <@${userId}>**`, `sessions: **${stats.sessions}**`, `total online: **${formatDuration(stats.totalS * 1e3)}**`, `avg session: **${formatDuration(stats.avgS * 1e3)}**`, `longest: **${formatDuration(stats.maxS * 1e3)}**`, stats.firstSeen ? `first seen: ${discordTimestamp(stats.firstSeen, "f")}` : "first seen: unknown", stats.last ? `last event: **${stats.last.event}** ${discordTimestamp(Number(stats.last.occurred_at), "R")}` : "last event: none" ];
    return this._send(lines.join("\n"));
  }
  async _status(userId) {
    if (!isSnowflake(userId)) {
      return this._send("usage: `status <id>`");
    }
    const status = this.tracker.currentStatus(userId);
    const tracked = this.tracker.tracked.has(userId) ? "yes" : "no";
    const channel = this.tracker.channelFor(userId);
    return this._send(`<@${userId}> — status: \`${status}\`, tracked: \`${tracked}\`, channel: ${channel ? `<#${channel}>` : "none"}`);
  }
  async _export(userIdRaw) {
    const userId = userIdRaw && userIdRaw.toLowerCase() !== "all" ? userIdRaw : null;
    if (userId && !isSnowflake(userId)) {
      return this._send("usage: `export <id>` or `export all`");
    }
    const rows = await this.db.getExportRows(userId);
    if (rows.length === 0) return this._send("nothing to export yet.");
    const capped = rows.slice(-this.config.exportLimit);
    const header = "user_id,name,event,prev_status,new_status,occurred_at,occurred_iso,duration_s";
    const lines = capped.map(row => {
      const iso = new Date(Number(row.occurred_at)).toISOString();
      return [ row.user_id, `"${String(row.name ?? "").replace(/"/g, '""')}"`, row.event, row.prev_status ?? "", row.new_status ?? "", row.occurred_at, iso, row.duration_s ?? "" ].join(",");
    });
    const scope = userId ? `<@${userId}>` : "all users";
    const truncatedNote = capped.length < rows.length ? ` (showing last ${capped.length} of ${rows.length})` : "";
    return this._send(`**export — ${scope}**${truncatedNote}\n\`\`\`csv\n${header}\n${lines.join("\n")}\n\`\`\``);
  }
}

import { logger, sleep, truncate } from "./util.js";

const MAX_CONTENT = 2e3;

export class Notifier {
  constructor(cfg, db) {
    this.cfg = cfg;
    this.db = db;
    this.webhookCache = new Map;
  }
  async send(content, channelId) {
    const text = String(content ?? "");
    if (!text.trim()) return;
    const targetChannel = channelId || this.cfg.defaultChannelId;
    if (!targetChannel) {
      logger.warn("notifier has no target channel; dropping message");
      return;
    }
    for (const chunk of this._chunk(text)) {
      await this._deliver(chunk, targetChannel);
    }
  }
  async setChannelWebhook(channelId, webhookUrl) {
    await this.db.setChannelWebhook(channelId, webhookUrl);
    this.webhookCache.set(channelId, webhookUrl);
  }
  _chunk(text) {
    if (text.length <= MAX_CONTENT - 10) return [ text ];
    const chunks = [];
    let rest = text;
    while (rest.length > 0) {
      let slice = rest.slice(0, MAX_CONTENT - 10);
      const lastNewline = slice.lastIndexOf("\n");
      if (lastNewline > 500) slice = slice.slice(0, lastNewline);
      chunks.push(slice);
      rest = rest.slice(slice.length).replace(/^\n/, "");
    }
    return chunks;
  }
  async _webhookFor(channelId) {
    if (channelId) {
      if (this.webhookCache.has(channelId)) {
        const cached = this.webhookCache.get(channelId);
        if (cached) return cached;
      } else {
        const stored = await this.db.getChannelWebhook(channelId);
        this.webhookCache.set(channelId, stored);
        if (stored) return stored;
      }
    }
    if (this.cfg.webhookUrl && (!channelId || channelId === this.cfg.defaultChannelId)) {
      return this.cfg.webhookUrl;
    }
    return null;
  }
  async _deliver(content, channelId) {
    const body = JSON.stringify({
      content,
      allowed_mentions: {
        parse: []
      }
    });
    const webhookUrl = await this._webhookFor(channelId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        let response;
        if (webhookUrl) {
          response = await fetch(webhookUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body
          });
        } else {
          response = await fetch(`${this.cfg.apiBase}/channels/${channelId}/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: this.cfg.token
            },
            body
          });
        }
        if (response.status === 429) {
          const data = await response.json().catch(() => ({}));
          const waitMs = Math.ceil((Number(data.retry_after) || 1) * 1e3) + 250;
          logger.warn(`notifier rate limited, waiting ${waitMs}ms`);
          await sleep(waitMs);
          continue;
        }
        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          logger.warn(`notifier failed ${response.status}: ${truncate(errorText, 300)}`);
          return;
        }
        return;
      } catch (err) {
        logger.warn("notifier network error:", err.message);
        await sleep(1e3 * (attempt + 1));
      }
    }
  }
}

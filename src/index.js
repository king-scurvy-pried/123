import { config } from "./config.js";

import { PresenceDB } from "./db.js";

import { Notifier } from "./notify.js";

import { Gateway } from "./gateway.js";

import { Tracker } from "./tracker.js";

import { CommandHandler } from "./commands.js";

import { startHealthServer } from "./keepalive.js";

import { logger, setLogLevel } from "./util.js";

setLogLevel(config.logLevel);

async function main() {
  const db = new PresenceDB(config);
  await db.init();
  db.startFlusher();
  const notifier = new Notifier(config, db);
  const tracker = new Tracker({
    config,
    db,
    notifier
  });
  await tracker.init();
  const gateway = new Gateway(config);
  const commands = new CommandHandler({
    config,
    db,
    tracker,
    notifier
  });
  gateway.on("READY", payload => {
    tracker.setSelf(payload.user);
    tracker.onReady(payload).catch(err => logger.warn("onReady failed:", err.message));
  });
  gateway.on("RESUMED", () => logger.info("gateway session resumed"));
  gateway.on("GUILD_CREATE", guild => {
    try {
      tracker.onGuildCreate(guild);
    } catch (err) {
      logger.warn("guild create handling failed:", err.message);
    }
  });
  gateway.on("PRESENCE_UPDATE", presence => {
    try {
      tracker.onPresenceUpdate(presence);
    } catch (err) {
      logger.warn("presence handling failed:", err.message);
    }
  });
  gateway.on("MESSAGE_CREATE", message => {
    commands.onMessage(message).catch(err => logger.warn("command handling failed:", err.message));
  });
  gateway.on("fatal", async ({code, reason}) => {
    logger.error(`fatal gateway error ${code}: ${reason}. shutting down.`);
    gateway.close();
    await db.flush().catch(() => {});
    setTimeout(() => process.exit(1), 1500);
  });
  gateway.connect();
  if (config.port > 0) {
    startHealthServer(config.port, () => ({
      ready: Boolean(tracker.self),
      user: tracker.self?.username ?? null,
      tracked: tracker.tracked.size,
      guilds: tracker.guilds.size,
      spooled_ops: db.queue.length
    }));
  }
  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`shutting down (${signal})`);
    gateway.close();
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", reason => logger.error("unhandled rejection:", reason));
  process.on("uncaughtException", err => logger.error("uncaught exception:", err));
  if (config.maxRuntimeMs > 0) {
    logger.info(`max runtime set: ${Math.round(config.maxRuntimeMs / 6e4)} minute(s)`);
    const timer = setTimeout(() => {
      logger.info("max runtime reached, shutting down gracefully");
      shutdown("max-runtime");
    }, config.maxRuntimeMs);
    if (timer.unref) timer.unref();
  }
  logger.info("presence tracker started");
}

main().catch(err => {
  logger.error("fatal startup error:", err);
  process.exit(1);
});

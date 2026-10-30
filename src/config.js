import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}. ` + `Set it in your .env or deployment secrets.`);
  }
  return value.trim();
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function intOptional(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${value}".`);
  }
  return parsed;
}

function listOptional(name) {
  const value = process.env[name];
  if (!value) return [];
  return value.split(",").map(entry => entry.trim()).filter(Boolean);
}

const singleControlChannel = optional("CONTROL_CHANNEL_ID", "");

const controlChannelList = [ ...new Set([ ...listOptional("CONTROL_CHANNEL_IDS"), ...singleControlChannel ? [ singleControlChannel ] : [] ]) ];

export const config = {
  token: required("DISCORD_TOKEN"),
  controlChannelIds: controlChannelList,
  defaultChannelId: controlChannelList[0] || "",
  webhookUrl: optional("WEBHOOK_URL", ""),
  allowedUserIds: listOptional("CONTROL_ALLOWED_USER_IDS"),
  debounceMs: intOptional("DEBOUNCE_MS", 6e4),
  intentsOverride: process.env.GATEWAY_INTENTS ? Number(process.env.GATEWAY_INTENTS) : null,
  presenceStatus: optional("BOT_PRESENCE", "online"),
  db: {
    url: optional("TURSO_DATABASE_URL", ""),
    authToken: optional("TURSO_AUTH_TOKEN", ""),
    localFile: optional("LOCAL_DB_FILE", "./data/presence.db")
  },
  spoolDir: optional("SPOOL_DIR", "./data"),
  exportLimit: intOptional("EXPORT_LIMIT", 5e3),
  port: intOptional("PORT", 7860),
  maxRuntimeMs: intOptional("MAX_RUNTIME_MS", 0),
  logLevel: optional("LOG_LEVEL", "info"),
  apiBase: optional("DISCORD_API_BASE", "https://discord.com/api/v10"),
  gatewayUrl: optional("GATEWAY_URL", "wss://gateway.discord.gg/?v=10&encoding=json")
};

export const nowMs = () => Date.now();

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isSnowflake(value) {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let threshold = LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
}

function emit(level, ...args) {
  if (LEVELS[level] < threshold) return;
  const ts = (new Date).toISOString();
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  stream(`[${ts}] ${level.toUpperCase()}`, ...args);
}

export const logger = {
  debug: (...a) => emit("debug", ...a),
  info: (...a) => emit("info", ...a),
  warn: (...a) => emit("warn", ...a),
  error: (...a) => emit("error", ...a)
};

export function discordTimestamp(ms, style = "f") {
  return `<t:${Math.floor(Number(ms) / 1e3)}:${style}>`;
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "unknown";
  const totalSec = Math.floor(ms / 1e3);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor(totalSec % 3600 / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function truncate(value, max) {
  const str = typeof value === "string" ? value : String(value ?? "");
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

export function escapeMd(value) {
  return String(value ?? "").replace(/([*_~`\\])/g, "\\$1");
}

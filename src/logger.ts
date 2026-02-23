import os from "node:os";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let minLevel: number = LEVELS.info;
let knightName = "unknown";

export function initLogger(knight: string, level: string): void {
  knightName = knight;
  minLevel = LEVELS[level as Level] ?? LEVELS.info;
}

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  const entry: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    pid: process.pid,
    hostname: os.hostname(),
    knight: knightName,
    msg,
    ...extra,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit("error", msg, extra),
};

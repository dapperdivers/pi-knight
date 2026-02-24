import os from "node:os";

export interface KnightConfig {
  knightName: string;
  knightModel: string;
  subscribeTopics: string[];
  natsUrl: string;
  taskTimeoutMs: number;
  maxConcurrentTasks: number;
  metricsPort: number;
  logLevel: string;
  hostname: string;
  thinkingLevel: string;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

export function loadConfig(): KnightConfig {
  return {
    knightName: requireEnv("KNIGHT_NAME"),
    knightModel: process.env["KNIGHT_MODEL"] ?? "anthropic/claude-sonnet-4-5",
    subscribeTopics: requireEnv("SUBSCRIBE_TOPICS").split(",").map((s) => s.trim()),
    natsUrl: process.env["NATS_URL"] ?? "nats://nats.database.svc.cluster.local:4222",
    taskTimeoutMs: parseInt(process.env["TASK_TIMEOUT_MS"] ?? "1800000", 10),
    maxConcurrentTasks: parseInt(process.env["MAX_CONCURRENT_TASKS"] ?? "2", 10),
    metricsPort: parseInt(process.env["METRICS_PORT"] ?? "3000", 10),
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    hostname: os.hostname(),
    thinkingLevel: process.env["KNIGHT_THINKING"] ?? "off",
  };
}

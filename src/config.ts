import os from "node:os";

export interface KnightConfig {
  knightName: string;
  knightModel: string;
  subscribeTopics: string[];
  natsUrl: string;
  natsTasksStream: string;
  natsResultsStream: string;
  natsResultsPrefix: string;
  taskTimeoutMs: number;
  maxConcurrentTasks: number;
  metricsPort: number;
  logLevel: string;
  hostname: string;
  thinkingLevel: string;
  maxRetryDelayMs: number;
  contextPruneTokens: number;
  thinkingBudgetLow: number;
  thinkingBudgetMedium: number;
  thinkingBudgetHigh: number;
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
    natsTasksStream: process.env["NATS_TASKS_STREAM"] ?? "fleet_a_tasks",
    natsResultsStream: process.env["NATS_RESULTS_STREAM"] ?? "fleet_a_results",
    natsResultsPrefix: process.env["NATS_RESULTS_PREFIX"] ?? "fleet-a.results",
    taskTimeoutMs: parseInt(process.env["TASK_TIMEOUT_MS"] ?? "1800000", 10),
    maxConcurrentTasks: parseInt(process.env["MAX_CONCURRENT_TASKS"] ?? "2", 10),
    metricsPort: parseInt(process.env["METRICS_PORT"] ?? "3000", 10),
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    hostname: os.hostname(),
    thinkingLevel: process.env["KNIGHT_THINKING"] ?? "off",
    maxRetryDelayMs: parseInt(process.env["MAX_RETRY_DELAY_MS"] ?? "60000", 10),
    contextPruneTokens: parseInt(process.env["CONTEXT_PRUNE_TOKENS"] ?? "100000", 10),
    thinkingBudgetLow: parseInt(process.env["THINKING_BUDGET_LOW"] ?? "1024", 10),
    thinkingBudgetMedium: parseInt(process.env["THINKING_BUDGET_MEDIUM"] ?? "4096", 10),
    thinkingBudgetHigh: parseInt(process.env["THINKING_BUDGET_HIGH"] ?? "8192", 10),
  };
}

import client from "prom-client";

export const registry = new client.Registry();

// Collect default Node.js metrics
client.collectDefaultMetrics({ register: registry });

export const tasksTotal = new client.Counter({
  name: "pi_knight_tasks_total",
  help: "Total tasks processed",
  labelNames: ["knight", "status"] as const,
  registers: [registry],
});

export const taskDuration = new client.Histogram({
  name: "pi_knight_task_duration_seconds",
  help: "Task execution duration in seconds",
  labelNames: ["knight"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800],
  registers: [registry],
});

export const llmCost = new client.Counter({
  name: "pi_knight_llm_cost_dollars_total",
  help: "Total LLM cost in dollars",
  labelNames: ["knight", "model"] as const,
  registers: [registry],
});

export const tokensTotal = new client.Counter({
  name: "pi_knight_tokens_total",
  help: "Total tokens used",
  labelNames: ["knight", "direction"] as const,
  registers: [registry],
});

export const natsConnected = new client.Gauge({
  name: "pi_knight_nats_connected",
  help: "NATS connection status (1=connected, 0=disconnected)",
  labelNames: ["knight"] as const,
  registers: [registry],
});

export const activeTasks = new client.Gauge({
  name: "pi_knight_active_tasks",
  help: "Currently active tasks",
  labelNames: ["knight"] as const,
  registers: [registry],
});

// ─── Tool call metrics (used by hooks.ts) ──────────────────────────

export const toolCallsTotal = new client.Counter({
  name: "pi_knight_tool_calls_total",
  help: "Total tool calls executed",
  labelNames: ["tool", "status"] as const,
  registers: [registry],
});

export const toolCallDuration = new client.Histogram({
  name: "pi_knight_tool_call_duration_seconds",
  help: "Tool call execution duration in seconds",
  labelNames: ["tool"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const toolCallErrors = new client.Counter({
  name: "pi_knight_tool_call_errors_total",
  help: "Total tool call errors",
  labelNames: ["tool"] as const,
  registers: [registry],
});

export const toolCallsBlocked = new client.Counter({
  name: "pi_knight_tool_calls_blocked_total",
  help: "Total tool calls blocked by safety hooks",
  labelNames: ["tool", "reason"] as const,
  registers: [registry],
});

import { loadConfig } from "./config.js";
import { initLogger, log } from "./logger.js";
import { connectNats, subscribe, publishResult, drain } from "./nats.js";
import { startHealthServer, stopHealthServer, setSkillCount, setActiveTaskCount } from "./health.js";
import { loadSkills } from "@mariozechner/pi-coding-agent";
import { executeTask } from "./knight.js";
import * as metrics from "./metrics.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config.knightName, config.logLevel);

  log.info("Pi-Knight starting", {
    model: config.knightModel,
    topics: config.subscribeTopics,
    skills: config.knightSkills,
  });

  // Start health/metrics HTTP server
  startHealthServer(config);
  log.info("Health server started", { port: config.metricsPort });

  // Discover skills using Pi SDK's built-in agentskills.io loader
  // Retry for git-sync race at startup
  let skillCount = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { skills, diagnostics } = loadSkills({
      cwd: "/data",
      agentDir: "/config",
      skillPaths: ["/skills"],
      includeDefaults: true,
    });
    skillCount = skills.length;
    if (skillCount > 0) {
      log.info("Skills loaded (Pi SDK)", {
        count: skillCount,
        names: skills.map((s) => s.name),
      });
      for (const d of diagnostics) {
        if (d.type === "warning") log.warn("Skill diagnostic", { message: d.message, path: d.path });
      }
      break;
    }
    if (attempt < 5) {
      log.info("No skills found, waiting for git-sync...", { attempt: attempt + 1 });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  setSkillCount(skillCount);

  // Connect to NATS
  await connectNats(config);
  metrics.natsConnected.labels(config.knightName).set(1);

  // Subscribe to task stream
  const tasks = await subscribe(config);

  // Task execution state
  let activeCount = 0;
  const taskQueue: Array<{ task: string; taskId: string; timeoutMs?: number }> = [];
  let shuttingDown = false;

  // Process a single task
  async function processTask(taskText: string, taskId: string, timeoutMs: number): Promise<void> {
    activeCount++;
    setActiveTaskCount(activeCount);
    metrics.activeTasks.labels(config.knightName).set(activeCount);

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await executeTask(taskText, config, controller.signal);
      const durationMs = Date.now() - startTime;

      await publishResult(taskId, {
        task_id: taskId,
        knight: config.knightName,
        success: true,
        result: result.result,
        duration_ms: durationMs,
        cost: result.cost,
        tokens: result.tokens,
        model: result.model,
        tool_calls: result.toolCalls,
        timestamp: new Date().toISOString(),
      });

      metrics.tasksTotal.labels(config.knightName, "success").inc();
      metrics.taskDuration.labels(config.knightName).observe(durationMs / 1000);
      metrics.llmCost.labels(config.knightName, result.model).inc(result.cost);
      metrics.tokensTotal.labels(config.knightName, "input").inc(result.tokens.input);
      metrics.tokensTotal.labels(config.knightName, "output").inc(result.tokens.output);
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Task failed", { taskId, error: errMsg });

      await publishResult(taskId, {
        task_id: taskId,
        knight: config.knightName,
        success: false,
        result: `Task failed: ${errMsg}`,
        duration_ms: durationMs,
        cost: 0,
        tokens: { input: 0, output: 0 },
        model: config.knightModel,
        timestamp: new Date().toISOString(),
      }).catch((e) => log.error("Failed to publish error result", { error: String(e) }));

      metrics.tasksTotal.labels(config.knightName, "error").inc();
      metrics.taskDuration.labels(config.knightName).observe(durationMs / 1000);
    } finally {
      clearTimeout(timeout);
      activeCount--;
      setActiveTaskCount(activeCount);
      metrics.activeTasks.labels(config.knightName).set(activeCount);

      if (taskQueue.length > 0 && activeCount < config.maxConcurrentTasks) {
        const next = taskQueue.shift()!;
        processTask(next.task, next.taskId, next.timeoutMs ?? config.taskTimeoutMs);
      }
    }
  }

  // Message loop
  (async () => {
    for await (const parsed of tasks) {
      if (shuttingDown) break;
      const timeoutMs = parsed.timeoutMs ?? config.taskTimeoutMs;

      if (activeCount >= config.maxConcurrentTasks) {
        log.info("At capacity, queuing task", { taskId: parsed.taskId, queueSize: taskQueue.length + 1 });
        taskQueue.push({ task: parsed.task, taskId: parsed.taskId, timeoutMs });
      } else {
        processTask(parsed.task, parsed.taskId, timeoutMs);
      }
    }
  })();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutdown signal received", { signal });
    shuttingDown = true;

    const maxWait = 60_000;
    const start = Date.now();
    while (activeCount > 0 && Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (activeCount > 0) {
      log.warn("Forcing shutdown with active tasks", { activeCount });
    }

    await drain().catch((e) => log.error("NATS drain error", { error: String(e) }));
    metrics.natsConnected.labels(config.knightName).set(0);
    await stopHealthServer();
    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  log.info("Pi-Knight ready");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

import { loadConfig } from "./config.js";
import { initLogger, log } from "./logger.js";
import { connectNats, subscribe, publishResult, drain, getStatus } from "./nats.js";
import { startHealthServer, stopHealthServer, setSkillCount, setActiveTaskCount } from "./health.js";
import { discoverSkills, type SkillCatalog } from "./skills.js";
import { executeTask } from "./knight.js";
import * as metrics from "./metrics.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config.knightName, config.logLevel);

  log.info("Pi-Knight starting", {
    knight: config.knightName,
    model: config.knightModel,
    topics: config.subscribeTopics,
    skills: config.knightSkills,
  });

  // Start health/metrics HTTP server
  startHealthServer(config);
  log.info("Health server started", { port: config.metricsPort });

  // Discover skills
  let skills: SkillCatalog = [];
  try {
    skills = await discoverSkills(config.knightSkills);
    setSkillCount(skills.length);
    log.info("Skills loaded", { count: skills.length });
  } catch (err) {
    log.warn("Skill discovery failed (continuing without skills)", {
      error: String(err),
    });
  }

  // Connect to NATS
  await connectNats(config);
  metrics.natsConnected.labels(config.knightName).set(1);

  // Subscribe to task stream
  const tasks = await subscribe(config);

  // Task execution state
  let activeCount = 0;
  const taskQueue: Array<{
    task: string;
    taskId: string;
    timeoutMs?: number;
  }> = [];
  let shuttingDown = false;

  // Process a single task
  async function processTask(
    taskText: string,
    taskId: string,
    timeoutMs: number,
  ): Promise<void> {
    activeCount++;
    setActiveTaskCount(activeCount);
    metrics.activeTasks.labels(config.knightName).set(activeCount);

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await executeTask(taskText, config, skills, controller.signal);
      const durationMs = Date.now() - startTime;

      // Publish result
      await publishResult(taskId, {
        task_id: taskId,
        knight: config.knightName,
        success: true,
        result: result.result,
        duration_ms: durationMs,
        cost: result.cost,
        tokens: result.tokens,
        model: result.model,
        timestamp: new Date().toISOString(),
      });

      // Update metrics
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

      // Process queued tasks
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
        // Fire and forget — processTask handles its own lifecycle
        processTask(parsed.task, parsed.taskId, timeoutMs);
      }
    }
  })();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutdown signal received", { signal });
    shuttingDown = true;

    // Wait for active tasks (with a hard timeout)
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

  log.info("Pi-Knight ready", { knight: config.knightName });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

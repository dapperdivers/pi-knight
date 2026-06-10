/**
 * Boot-time preflight for local OpenAI-compatible model endpoints (Ollama, LM Studio,
 * LiteLLM, …).
 *
 * Cloud providers (Anthropic, OpenRouter, Google, …) are skipped — they have stable,
 * well-known endpoints. Local endpoints have two classes of misconfiguration that are
 * invisible until the first task and then surface as cryptic errors, so we surface them
 * at boot instead:
 *
 *  1. Endpoint unreachable / model not pulled — fail fast with a clear message rather
 *     than letting the first NATS task 404 deep inside the SDK.
 *  2. Ollama context truncation — Ollama's OpenAI-compatible endpoint silently caps
 *     context at its server default (num_ctx, historically ~2048, newer builds ~4096)
 *     unless the model's Modelfile raises it, *regardless of the contextWindow we
 *     advertise*. A knight that thinks it has 131k tokens but is truncated to 2048
 *     degrades silently. We probe Ollama's native /api/show and warn loudly on a
 *     mismatch.
 *
 * We talk to the same OpenAI-compatible `/models` endpoint the SDK's openai-completions
 * provider connects to, so a green reachability check means the SDK's own client should
 * connect too — we stay on the SDK's path rather than inventing a parallel one.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { log } from "./logger.js";

const PROBE_TIMEOUT_MS = 5000;

/** Hosts that indicate a local/self-hosted endpoint worth preflighting. */
const LOCAL_HOST_RE = /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)|:11434\b/;

interface OllamaShow {
  /** Modelfile parameters as a newline-delimited string (e.g. "num_ctx 8192\nstop ..."). */
  parameters?: string;
  /** Architecture metadata; holds "<arch>.context_length" = trained max context. */
  model_info?: Record<string, unknown>;
}

interface OllamaPs {
  /** Currently-loaded models. Each entry's context_length reflects the *effective*
   *  context the model was loaded with — including a server-level OLLAMA_CONTEXT_LENGTH,
   *  which /api/show does NOT expose. This is the authoritative source when available. */
  models?: Array<{ name?: string; model?: string; context_length?: unknown }>;
}

/** True when the resolved model points at a local OpenAI-compatible endpoint. */
export function isLocalEndpoint(model: Model<Api>): boolean {
  return model.provider === "ollama" || LOCAL_HOST_RE.test(model.baseUrl);
}

/** True when the endpoint is Ollama specifically (enables the num_ctx probe). */
function isOllama(model: Model<Api>): boolean {
  return model.provider === "ollama" || model.baseUrl.includes(":11434");
}

/**
 * Preflight a resolved model. No-op for non-local endpoints. Throws if a local endpoint
 * is unreachable (fail fast); otherwise warns on suspicious configuration and returns.
 */
export async function preflightModel(model: Model<Api>): Promise<void> {
  if (!isLocalEndpoint(model)) {
    log.debug("Preflight skipped (non-local endpoint)", { provider: model.provider, baseUrl: model.baseUrl });
    return;
  }

  const baseUrl = model.baseUrl.replace(/\/$/, "");
  log.info("Preflighting local model endpoint", { provider: model.provider, model: model.id, baseUrl });

  await checkReachableAndModel(baseUrl, model); // fatal on unreachable
  if (isOllama(model)) {
    await checkOllamaContext(baseUrl, model); // non-fatal: warn only
  }
}

/** Hit the OpenAI-compatible /models list: fatal if unreachable, warn if model absent. */
async function checkReachableAndModel(baseUrl: string, model: Model<Api>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Model endpoint unreachable at ${baseUrl}/models (${msg}). ` +
        `Check the endpoint is running and OPENAI_BASE_URL points at it ` +
        `(for Ollama: http://<host>:11434/v1).`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Model endpoint ${baseUrl}/models returned HTTP ${res.status}. ` +
        `Endpoint reachable but not serving an OpenAI-compatible model list.`,
    );
  }

  let ids: string[];
  try {
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
  } catch {
    log.warn("Preflight: /models returned unexpected JSON; skipping model-presence check", { baseUrl });
    return;
  }

  if (ids.length === 0) {
    log.warn("Preflight: endpoint serves no models", { baseUrl });
    return;
  }

  if (modelIsPresent(model.id, ids)) {
    log.info("Preflight OK: model is available at endpoint", { model: model.id, availableCount: ids.length });
  } else {
    // Tag normalization is fuzzy (e.g. "llama3.1" vs "llama3.1:latest"), so warn loudly
    // rather than hard-fail and risk bricking a pod on a false negative.
    log.warn(
      "Preflight: configured model not found at endpoint — the first task will fail if the tag is wrong. " +
        "Pull it (e.g. `ollama pull <model>`) or fix KNIGHT_MODEL.",
      { model: model.id, available: ids.slice(0, 20) },
    );
  }
}

/** Compare requested model id against the endpoint's list, tolerating a `:latest` tag. */
function modelIsPresent(wanted: string, available: string[]): boolean {
  const norm = (s: string) => s.replace(/:latest$/, "");
  const w = norm(wanted);
  return available.some((a) => a === wanted || norm(a) === w);
}

/**
 * Probe Ollama for the model's effective context length and warn if it falls below the
 * context window this knight advertises (the silent-truncation footgun). Entirely
 * non-fatal — older builds or proxied endpoints may not expose these endpoints.
 *
 * Two sources, in order of authority:
 *   1. /api/ps — the *effective* context_length a loaded model is running with. This
 *      reflects a server-level OLLAMA_CONTEXT_LENGTH, which /api/show does NOT expose, so
 *      it is the source of truth when the model is loaded (knights keep it warm via
 *      OLLAMA_KEEP_ALIVE). Note: against a round-robin pool Service this only reflects the
 *      one backend we hit — verify every pool member is loaded the same way.
 *   2. /api/show — the Modelfile's `num_ctx` parameter, if one was baked in.
 * If neither yields a number we cannot assert truncation, so we emit a soft pointer
 * rather than a false alarm (the limit may be set via OLLAMA_CONTEXT_LENGTH, opaque here).
 */
async function checkOllamaContext(baseUrl: string, model: Model<Api>): Promise<void> {
  // The native API lives one level up from the OpenAI-compatible /v1.
  const nativeBase = baseUrl.replace(/\/v1$/, "");
  const declared = model.contextWindow;

  // 1. Authoritative: effective context of the loaded model.
  const loadedCtx = await probeLoadedContext(nativeBase, model.id);
  if (loadedCtx != null) {
    reportContext(loadedCtx, declared, model.id, "loaded (/api/ps)");
    return;
  }

  // 2. Modelfile num_ctx via /api/show.
  const body = await probeShow(nativeBase, model.id);
  const explicitNumCtx = body ? extractNumCtx(body) : null;
  if (explicitNumCtx != null) {
    reportContext(explicitNumCtx, declared, model.id, "Modelfile num_ctx");
    return;
  }

  // 3. Couldn't determine the effective context from either source. Don't cry wolf — the
  //    server may set it via OLLAMA_CONTEXT_LENGTH (not introspectable here). Point the
  //    operator at the thing to verify.
  const trainedMax = body ? extractTrainedContext(body) : null;
  log.info(
    "Preflight: could not confirm Ollama's effective context length (model not loaded, and " +
      "no Modelfile num_ctx). Ensure the server's OLLAMA_CONTEXT_LENGTH (or a Modelfile " +
      "num_ctx) is >= this knight's MODEL_CONTEXT_WINDOW, or prompts will be silently truncated.",
    { advertisedContextWindow: declared, trainedMaxContext: trainedMax ?? "unknown", model: model.id },
  );
}

/** Emit OK/warn for an effective context length vs the advertised window. */
function reportContext(effective: number, declared: number, model: string, source: string): void {
  if (effective < declared) {
    log.warn(
      "Preflight: Ollama's effective context is smaller than this knight's advertised context " +
        "window — prompts above it will be silently truncated. Raise the server's " +
        "OLLAMA_CONTEXT_LENGTH (or the Modelfile num_ctx), or lower MODEL_CONTEXT_WINDOW to match.",
      { effectiveContext: effective, advertisedContextWindow: declared, source, model },
    );
  } else {
    log.info("Preflight OK: Ollama context covers the advertised window", {
      effectiveContext: effective,
      advertisedContextWindow: declared,
      source,
    });
  }
}

/** GET /api/ps and return the effective context_length of the matching loaded model. */
async function probeLoadedContext(nativeBase: string, modelId: string): Promise<number | null> {
  try {
    const res = await fetch(`${nativeBase}/api/ps`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as OllamaPs;
    const norm = (s: string) => s.replace(/:latest$/, "");
    const entry = (body.models ?? []).find((m) => {
      const id = m.model ?? m.name ?? "";
      return id === modelId || norm(id) === norm(modelId);
    });
    return typeof entry?.context_length === "number" ? entry.context_length : null;
  } catch {
    return null;
  }
}

/** POST /api/show and return the parsed body, or null if unavailable. */
async function probeShow(nativeBase: string, modelId: string): Promise<OllamaShow | null> {
  try {
    const res = await fetch(`${nativeBase}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `model` is the current field; `name` covers older Ollama builds.
      body: JSON.stringify({ model: modelId, name: modelId }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as OllamaShow;
  } catch {
    return null;
  }
}

/** Pull an explicit `num_ctx N` out of Ollama's Modelfile parameters string, if present. */
function extractNumCtx(body: OllamaShow): number | null {
  const match = (body.parameters ?? "").match(/^\s*num_ctx\s+(\d+)/m);
  return match ? parseInt(match[1], 10) : null;
}

/** Pull the model's trained max context ("<arch>.context_length") from model_info. */
function extractTrainedContext(body: OllamaShow): number | null {
  for (const [key, value] of Object.entries(body.model_info ?? {})) {
    if (key.endsWith(".context_length") && typeof value === "number") return value;
  }
  return null;
}

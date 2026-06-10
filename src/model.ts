/**
 * Shared model + auth resolution for knight and sub-agent sessions.
 *
 * One place resolves a "provider/model" string into a usable Model plus the
 * AuthStorage/ModelRegistry to pass to createAgentSession — so the knight and
 * its sub-agents never drift apart on model selection or auth handling.
 */
import { getModel, type Api, type Model } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.js";

// Custom-model catalog read by the SDK ModelRegistry. Defaults to the workspace PVC;
// override (e.g. to a read-only ConfigMap mount like /config/models.json) via env so a
// fleet can ship a declarative local-model catalog instead of the per-knight env triplet.
const MODELS_JSON = process.env.MODELS_JSON_PATH || "/data/models.json";

/**
 * Default base URLs for known local OpenAI-compatible providers, keyed by the
 * provider segment of a "provider/model" string. Mirrors the SDK's convention of
 * letting the provider *name* drive endpoint/compat selection (see openai-completions
 * detectCompat). Ollama serves an OpenAI-compatible API at /v1, so mapping the
 * provider name "ollama" here means `KNIGHT_MODEL=ollama/<tag>` works with no extra
 * env. An explicit OPENAI_BASE_URL still wins (e.g. a non-localhost cluster service).
 */
const LOCAL_PROVIDER_BASE_URLS: Record<string, string> = {
  ollama: "http://localhost:11434/v1",
};

export interface ResolvedModel {
  model: Model<Api>;
  provider: string;
  modelName: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

/** Parse "provider/model" → { provider, modelName }. Defaults provider to anthropic. */
export function parseModelStr(modelStr: string): { provider: string; modelName: string } {
  const slashIdx = modelStr.indexOf("/");
  return slashIdx > 0
    ? { provider: modelStr.slice(0, slashIdx), modelName: modelStr.slice(slashIdx + 1) }
    : { provider: "anthropic", modelName: modelStr };
}

/**
 * OpenRouter routing-variant suffixes. These pick a routing strategy/variant
 * (e.g. cheapest provider) without changing which catalog model runs, so the
 * registry has no exact catalog entry for the suffixed slug. We strip them for
 * the catalog lookup (to keep baseUrl + pricing) but send the full slug to the
 * API so OpenRouter still applies the variant.
 * https://openrouter.ai/docs/features/provider-routing
 *
 * Cost-tracking accuracy varies by suffix (pricing always comes from the base
 * catalog entry):
 *  - `:floor` / `:nitro` — same model, just provider selection. Accurate. This
 *    is the intended use case.
 *  - `:free` — routes to a $0 variant priced as paid → reported cost is an
 *    over-estimate. (Some community models exist *only* as `:free` with no paid
 *    base; those miss the stripped lookup and land in the localhost fallback.)
 *  - `:online` — adds OpenRouter's web-search plugin (per-request fee on top of
 *    the base) → reported cost is an under-estimate.
 * Genuine model-variant suffixes (`:thinking`, `:extended`, `:beta`) are
 * deliberately *not* listed: they are distinct catalog entries with their own
 * pricing, so they should fall through to an exact match, not be stripped.
 */
const ROUTING_SUFFIXES = new Set(["floor", "nitro", "free", "online", "exacto"]);

/** Split a trailing routing suffix (e.g. ":floor") off a model name for catalog lookup. */
export function splitRoutingSuffix(modelName: string): { base: string; suffix?: string } {
  const colonIdx = modelName.lastIndexOf(":");
  if (colonIdx === -1) return { base: modelName };
  const suffix = modelName.slice(colonIdx + 1);
  return ROUTING_SUFFIXES.has(suffix) ? { base: modelName.slice(0, colonIdx), suffix } : { base: modelName };
}

/**
 * Resolve a model + auth for a "provider/model" string.
 *
 * In-memory AuthStorage avoids /data/auth.json lock deadlocks on SIGKILL. The
 * ModelRegistry reads /data/models.json (custom providers/models) and resolves API
 * keys via the correct per-provider env vars (e.g. GEMINI_API_KEY for google,
 * ANTHROPIC_OAUTH_TOKEN/ANTHROPIC_API_KEY for anthropic), auth.json, and OAuth.
 *
 * Falls back to a hand-built openai-completions model for env-driven local endpoints
 * (LiteLLM/Ollama) with no models.json entry. When no auth is configured anywhere, a
 * dummy runtime key is set so the SDK reaches keyless local endpoints instead of bailing.
 */
export function resolveModel(modelStr: string): ResolvedModel {
  const { provider, modelName } = parseModelStr(modelStr);
  // Strip any routing-variant suffix for the catalog lookup; the full slug
  // (with suffix) is still what we send to the API via model.id below.
  const { base: lookupName, suffix: routingSuffix } = splitRoutingSuffix(modelName);

  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.create(authStorage, MODELS_JSON);
  const registryError = modelRegistry.getError();
  if (registryError) {
    log.warn("models.json failed to load; using built-in models only", { error: registryError });
  }

  // Registry first (built-in + custom models.json); getModel is a redundant built-in fallback.
  let model = (modelRegistry.find(provider, lookupName) ?? getModel(provider as any, lookupName as any)) as
    | Model<Api>
    | undefined;

  // Catalog hit on the base slug: clone (the registry returns a shared reference)
  // and restore the routing suffix on the id so OpenRouter applies the variant
  // while pricing/baseUrl come from the catalog entry.
  if (model && routingSuffix) {
    log.info("Applying routing suffix to resolved model", { model: lookupName, suffix: routingSuffix });
    model = { ...model, id: modelName } as Model<Api>;
  }

  if (!model) {
    const baseUrl =
      process.env.OPENAI_BASE_URL ||
      process.env.OPENAI_API_BASE ||
      LOCAL_PROVIDER_BASE_URLS[provider] ||
      "http://localhost:4000/v1";
    const contextWindow = parseInt(process.env.MODEL_CONTEXT_WINDOW ?? "131072", 10);
    const maxTokens = parseInt(process.env.MODEL_MAX_TOKENS ?? "16384", 10);
    // Reasoning is off by default (most local chat models), but opt-in for reasoning
    // models served locally (e.g. gpt-oss) so pi surfaces their thinking instead of
    // letting it ride along in an unparsed side field. Set MODEL_REASONING=true.
    const reasoning = process.env.MODEL_REASONING === "true";
    log.info("Model not in registry, creating custom openai-completions model", {
      provider, model: modelName, baseUrl, contextWindow, maxTokens, reasoning,
    });
    model = {
      id: modelName,
      name: modelName,
      api: "openai-completions",
      provider,
      baseUrl,
      reasoning,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
        supportsStore: false,
        maxTokensField: "max_tokens",
      },
    } as unknown as Model<Api>;
  }

  // Dummy key only when no auth is configured anywhere — hasConfiguredAuth() uses the
  // registry's correct provider→env-var map, so real keys are never clobbered.
  if (!modelRegistry.hasConfiguredAuth(model)) {
    authStorage.setRuntimeApiKey(provider, "ollama");
  }

  return { model, provider, modelName, authStorage, modelRegistry };
}

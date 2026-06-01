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

const MODELS_JSON = "/data/models.json";

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

  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.create(authStorage, MODELS_JSON);
  const registryError = modelRegistry.getError();
  if (registryError) {
    log.warn("models.json failed to load; using built-in models only", { error: registryError });
  }

  // Registry first (built-in + custom models.json); getModel is a redundant built-in fallback.
  let model = (modelRegistry.find(provider, modelName) ?? getModel(provider as any, modelName as any)) as
    | Model<Api>
    | undefined;

  if (!model) {
    const baseUrl = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "http://localhost:4000/v1";
    const contextWindow = parseInt(process.env.MODEL_CONTEXT_WINDOW ?? "131072", 10);
    const maxTokens = parseInt(process.env.MODEL_MAX_TOKENS ?? "16384", 10);
    log.info("Model not in registry, creating custom openai-completions model", {
      provider, model: modelName, baseUrl, contextWindow, maxTokens,
    });
    model = {
      id: modelName,
      name: modelName,
      api: "openai-completions",
      provider,
      baseUrl,
      reasoning: false,
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

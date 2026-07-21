import type { Config } from "./config";

export type ProviderName = "kilo" | "opencode";

export interface UpstreamTarget {
  provider: ProviderName;
  model: string;
}

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
}

const CAPABILITIES: Record<string, ModelCapabilities> = {
  "opencode/deepseek-v4-flash-free": { tools: true, vision: false },
  "opencode/big-pickle": { tools: true, vision: false },
  "opencode/mimo-v2.5-free": { tools: true, vision: false },
  "opencode/north-mini-code-free": { tools: true, vision: false },
  "opencode/nemotron-3-ultra-free": { tools: true, vision: false },
  "kilo/stepfun/step-3.7-flash:free": { tools: true, vision: true },
  "kilo/poolside/laguna-m.1:free": { tools: true, vision: false },
  "kilo/cohere/north-mini-code:free": { tools: true, vision: false },
};

export function parseTarget(value: string, fallbackProvider: ProviderName = "kilo"): UpstreamTarget {
  const slash = value.indexOf("/");
  if (slash > 0) {
    const prefix = value.slice(0, slash).toLowerCase();
    if (prefix === "kilo" || prefix === "opencode") {
      return { provider: prefix, model: value.slice(slash + 1) };
    }
  }
  return { provider: fallbackProvider, model: value };
}

export function getProvider(config: Config, provider: ProviderName) {
  if (provider === "opencode") {
    return {
      name: provider,
      baseUrl: config.opencodeBaseUrl,
      apiKey: config.opencodeApiKey,
    };
  }
  return {
    name: provider,
    baseUrl: config.kiloBaseUrl,
    apiKey: config.kiloApiKey,
  };
}

export function providerEnabled(config: Config, provider: ProviderName): boolean {
  return Boolean(getProvider(config, provider).apiKey);
}

export function displayTarget(target: UpstreamTarget): string {
  return `${target.provider}/${target.model}`;
}

export function isFreeTarget(target: UpstreamTarget): boolean {
  return target.provider === "opencode"
    ? target.model.endsWith("-free") || target.model === "big-pickle"
    : target.model.endsWith(":free") || target.model === "kilo-auto/free";
}

export function getCapabilities(target: UpstreamTarget): ModelCapabilities {
  // Unknown free models are allowed for text-only requests, but never assumed
  // to support Claude Code tools or image input.
  return CAPABILITIES[displayTarget(target)] ?? { tools: false, vision: false };
}

import { existsSync } from "fs";
import { log } from "./logger";
import type { Config } from "./types";

function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (
      sourceVal &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      ) as T[keyof T];
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal as T[keyof T];
    }
  }
  return result;
}

async function loadJson<T>(path: string): Promise<T> {
  return Bun.file(path).json() as Promise<T>;
}

export async function loadConfig(
  defaultPath: string,
  projectPath?: string,
  cliOverridePath?: string,
): Promise<Config> {
  let config = await loadJson<Config>(defaultPath);

  if (projectPath && existsSync(projectPath)) {
    log.debug("Loading project config:", projectPath);
    const projectConfig = await loadJson<Partial<Config>>(projectPath);
    config = deepMerge(config, projectConfig);
  }

  if (cliOverridePath && existsSync(cliOverridePath)) {
    log.debug("Loading CLI config override:", cliOverridePath);
    const cliConfig = await loadJson<Partial<Config>>(cliOverridePath);
    config = deepMerge(config, cliConfig);
  }

  return config;
}

export function applyOverrides(
  config: Config,
  overrides: { maxBudget?: number; model?: string },
): Config {
  const result = structuredClone(config);
  if (overrides.maxBudget !== undefined) {
    result.budget.total_max_usd = overrides.maxBudget;
  }
  if (overrides.model) {
    result.models.planner = overrides.model;
    result.models.executor = overrides.model;
  }
  return result;
}

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildDefaultConfig } from "./defaults.js";
import type { SwarmConfig } from "./types.js";

/** Package source directory — used to resolve built-in prompt paths regardless of CWD */
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load a SwarmConfig from a YAML file or config package directory.
 * If configPath is a directory, looks for swarm.yaml inside it.
 */
export async function loadConfigFromFile(configPath: string): Promise<SwarmConfig> {
  const absPath = resolve(configPath);

  // Detect config package (directory with swarm.yaml)
  if (existsSync(absPath) && statSync(absPath).isDirectory()) {
    return loadConfigPackage(absPath);
  }

  const raw = readFileSync(absPath, "utf-8");
  const partial = parse(raw) as Partial<SwarmConfig>;
  const config = mergeWithDefaults(partial);
  return resolvePromptPaths(config, dirname(absPath));
}

/**
 * Load a v2 config package from a directory.
 * Expects: <dir>/swarm.yaml plus optional tools/, prompts/, strategies/, nudges/
 */
export async function loadConfigPackage(packageDir: string): Promise<SwarmConfig> {
  const absDir = resolve(packageDir);
  const yamlPath = resolve(absDir, "swarm.yaml");

  if (!existsSync(yamlPath)) {
    throw new Error(`Config package directory "${absDir}" does not contain swarm.yaml`);
  }

  const raw = readFileSync(yamlPath, "utf-8");
  const partial = parse(raw) as Partial<SwarmConfig>;
  const config = mergeWithDefaults(partial);

  // Tag the config with its package root for runtime path resolution
  config.configPackageDir = absDir;

  // Resolve all file paths relative to the package directory
  resolvePackagePaths(config, absDir);

  return resolvePromptPaths(config, absDir);
}

/**
 * Resolve tool file paths, strategy file paths, and nudge strategy paths
 * relative to the config package directory.
 */
function resolvePackagePaths(config: SwarmConfig, packageDir: string): void {
  // Resolve tool file paths
  for (const [_name, tool] of Object.entries(config.tools)) {
    if (tool.file && !tool.file.startsWith("/")) {
      tool.file = resolve(packageDir, tool.file);
    }
  }

  // Resolve synthesis strategy file paths
  if (config.synthesis?.strategies) {
    for (const [_name, strategy] of Object.entries(config.synthesis.strategies)) {
      if (typeof strategy.file === "string" && !strategy.file.startsWith("/")) {
        strategy.file = resolve(packageDir, strategy.file);
      }
    }
  }

  // Resolve agent nudge strategy file paths
  for (const [_name, agent] of Object.entries(config.agents)) {
    if (agent.nudgeStrategy && !agent.nudgeStrategy.startsWith("/") && agent.nudgeStrategy !== "default") {
      agent.nudgeStrategy = resolve(packageDir, agent.nudgeStrategy);
    }
  }
}

/**
 * Deep-merge a partial config with the full defaults.
 * Arrays replace rather than merge (e.g. agent tool lists replace the default).
 */
export function mergeWithDefaults(partial: Partial<SwarmConfig>): SwarmConfig {
  const defaults = buildDefaultConfig();
  return deepMerge(
    defaults as unknown as Record<string, unknown>,
    partial as unknown as Record<string, unknown>,
  ) as unknown as SwarmConfig;
}

/**
 * Resolve relative systemPrompt file paths against the config file directory.
 * Paths that are already absolute or start with "inline:" are left as-is.
 */
export function resolvePromptPaths(config: SwarmConfig, configDir: string): SwarmConfig {
  const resolved = structuredClone(config);

  for (const [name, agent] of Object.entries(resolved.agents)) {
    if (agent.systemPrompt && !agent.systemPrompt.startsWith("inline:")) {
      // Only resolve if not already absolute
      if (!agent.systemPrompt.startsWith("/")) {
        // Try config file's directory first (user-provided custom prompts),
        // then fall back to package source directory (built-in prompts).
        // This ensures npm-linked installs resolve built-in prompts correctly.
        const fromConfig = resolve(configDir, agent.systemPrompt);
        if (existsSync(fromConfig)) {
          agent.systemPrompt = fromConfig;
        } else {
          agent.systemPrompt = resolve(SRC_DIR, agent.systemPrompt);
        }
      }
    }
    // Ensure agent.name matches its key
    agent.name = name;
  }

  return resolved;
}

// ── Deep merge utility ──────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
      result[key] = deepMerge(targetVal, sourceVal);
    } else if (sourceVal !== undefined) {
      // Arrays and primitives: source replaces target
      result[key] = sourceVal;
    }
  }

  return result;
}

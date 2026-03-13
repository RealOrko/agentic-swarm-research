import type { Context } from "./context.js";
import { buildDefaultConfig } from "./config/index.js";
import { SwarmRunner } from "./swarm-runner.js";

/**
 * Run a research swarm with the given goal.
 * This is a backward-compatibility wrapper around SwarmRunner.
 */
export async function runResearch(
  goal: string,
  vectorKvKey?: string
): Promise<Context> {
  const config = buildDefaultConfig();
  const runner = await SwarmRunner.fromConfig(config);
  const result = await runner.run(goal, vectorKvKey ? { vectorKey: vectorKvKey } : undefined);
  return result.ctx;
}

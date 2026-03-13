// Re-export from synthesis/strategies for backward compatibility
export { TournamentSynthesis } from "./synthesis/strategies.js";
export type { Finding } from "./synthesis/strategies.js";

// Legacy function — delegates to TournamentSynthesis
import type { Context } from "./context.js";
import type { Finding } from "./synthesis/strategies.js";
import { TournamentSynthesis } from "./synthesis/strategies.js";
import { AgentFactory } from "./agent-factory.js";
import { buildDefaultConfig } from "./config/index.js";

export async function tournamentSynthesize(
  goal: string,
  findings: Finding[],
  ctx: Context,
  depth: number = 0
): Promise<string> {
  const config = buildDefaultConfig();
  const agentFactory = new AgentFactory(config);
  const strategy = new TournamentSynthesis("synthesizer", 3, 3);
  return strategy.synthesize(goal, findings, ctx, agentFactory);
}

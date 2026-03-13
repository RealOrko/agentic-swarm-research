import { addNode, getRootId } from "../context.js";
import type { Context } from "../context.js";
import type { AgentFactory } from "../agent-factory.js";

export interface Finding {
  question: string;
  answer: string;
  sources: string[];
}

export interface SynthesisStrategy {
  synthesize(
    goal: string,
    findings: Finding[],
    ctx: Context,
    agentFactory: AgentFactory,
  ): Promise<string>;
}

// -- Helpers ------------------------------------------------------------------

function pairUp<T>(items: T[]): T[][] {
  const pairs: T[][] = [];
  for (let i = 0; i < items.length; i += 2) {
    if (i + 1 < items.length) {
      pairs.push([items[i], items[i + 1]]);
    } else {
      pairs.push([items[i]]);
    }
  }
  return pairs;
}

function formatFindings(findings: Finding[], goal: string): string {
  const findingsText = findings
    .map(
      (f, i) =>
        `## Finding ${i + 1}: ${f.question}\n\n${f.answer}\n\nSources: ${f.sources.join(", ")}`
    )
    .join("\n\n---\n\n");

  return `Original goal: ${goal}\n\nResearch findings:\n\n${findingsText}`;
}

// -- Tournament Synthesis -----------------------------------------------------

export class TournamentSynthesis implements SynthesisStrategy {
  constructor(
    private synthesizerAgent: string,
    private maxDepth: number = 3,
    private baseCaseSize: number = 3,
  ) {}

  async synthesize(
    goal: string,
    findings: Finding[],
    ctx: Context,
    agentFactory: AgentFactory,
  ): Promise<string> {
    return this.tournamentRound(goal, findings, ctx, agentFactory, 0);
  }

  private async tournamentRound(
    goal: string,
    findings: Finding[],
    ctx: Context,
    agentFactory: AgentFactory,
    depth: number,
  ): Promise<string> {
    const rootId = getRootId(ctx);

    // Base case
    if (findings.length <= this.baseCaseSize || depth >= this.maxDepth) {
      const parentNode = addNode(ctx, {
        type: "synthesis",
        parentId: rootId,
        content: null,
        source: "tournament-final",
        summary: `Final synthesis of ${findings.length} findings`,
      });

      const workerResult = await agentFactory.spawnWorker(
        this.synthesizerAgent,
        formatFindings(findings, goal),
        ctx,
        { name: "synthesizer" }
      );

      const result = workerResult.result;

      ctx.db.updateNodeContent(
        ctx.sessionId,
        parentNode.id,
        result,
        result.length > 300 ? result.slice(0, 300) + "..." : result,
        Math.ceil(result.length / 3)
      );

      return result;
    }

    // Tournament round: pair up and synthesize
    const pairs = pairUp(findings);
    const roundLabel = `round-${depth + 1}`;

    const roundNode = addNode(ctx, {
      type: "synthesis",
      parentId: rootId,
      content: null,
      source: `tournament-${roundLabel}`,
      summary: `Tournament ${roundLabel}: ${pairs.length} pairs from ${findings.length} findings`,
    });

    const intermediates = await Promise.all(
      pairs.map(async (pair, i) => {
        const pairLabel = `${roundLabel}-pair${i + 1}`;
        const workerResult = await agentFactory.spawnWorker(
          this.synthesizerAgent,
          formatFindings(pair, goal),
          ctx,
          { name: `synthesizer-${pairLabel}` }
        );

        const result = workerResult.result;
        const allSources = pair.flatMap((f) => f.sources);

        addNode(ctx, {
          type: "synthesis",
          parentId: roundNode.id,
          content: result,
          source: `tournament-${pairLabel}`,
          metadata: { inputCount: pair.length },
        });

        return {
          question: `Intermediate synthesis (${pairLabel})`,
          answer: result,
          sources: [...new Set(allSources)],
        };
      })
    );

    return this.tournamentRound(goal, intermediates, ctx, agentFactory, depth + 1);
  }
}

// -- Single-Pass Synthesis ----------------------------------------------------

export class SinglePassSynthesis implements SynthesisStrategy {
  constructor(private synthesizerAgent: string) {}

  async synthesize(
    goal: string,
    findings: Finding[],
    ctx: Context,
    agentFactory: AgentFactory,
  ): Promise<string> {
    const workerResult = await agentFactory.spawnWorker(
      this.synthesizerAgent,
      formatFindings(findings, goal),
      ctx,
      { name: "synthesizer" }
    );
    return workerResult.result;
  }
}

// -- Strategy Factory ---------------------------------------------------------

export function createSynthesisStrategy(
  config: { default: string; strategies: Record<string, Record<string, unknown>> }
): SynthesisStrategy {
  const strategyName = config.default;
  const strategyConfig = config.strategies[strategyName] || {};

  switch (strategyName) {
    case "tournament":
      return new TournamentSynthesis(
        (strategyConfig.synthesizerAgent as string) || "synthesizer",
        (strategyConfig.maxDepth as number) || 3,
        (strategyConfig.baseCaseSize as number) || 3,
      );
    case "single-pass":
      return new SinglePassSynthesis(
        (strategyConfig.synthesizerAgent as string) || "synthesizer",
      );
    default:
      // Fall back to tournament
      return new TournamentSynthesis("synthesizer", 3, 3);
  }
}

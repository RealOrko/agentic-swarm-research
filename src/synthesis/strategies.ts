import { addNode, getRootId } from "../context.js";
import type { Context } from "../context.js";
import type { AgentFactory } from "../agent-factory.js";
import { log } from "../logger.js";
import { dedupeSources } from "./postprocess.js";

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

/**
 * Retry a spawnWorker call. The base-case synthesis is a single network call
 * with no fallback — a transient LLM failure (worker timeout, connection
 * blip, rate limit) would otherwise abort the whole synthesis.
 */
async function spawnWithRetry(
  agentFactory: AgentFactory,
  agentName: string,
  userMessage: string,
  ctx: Context,
  overrides: { name: string },
  opts: { maxAttempts: number; baseDelayMs: number },
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const r = await agentFactory.spawnWorker(agentName, userMessage, ctx, overrides);
      return r.result;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < opts.maxAttempts) {
        const delay = opts.baseDelayMs * Math.pow(2, attempt - 1);
        log("synthesis", `${overrides.name} attempt ${attempt}/${opts.maxAttempts} failed (${msg}); retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        log("synthesis", `${overrides.name} attempt ${attempt}/${opts.maxAttempts} failed (${msg}); no retries left`);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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

      const result = await spawnWithRetry(
        agentFactory,
        this.synthesizerAgent,
        formatFindings(findings, goal),
        ctx,
        { name: "synthesizer" },
        { maxAttempts: 3, baseDelayMs: 500 },
      );

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

    // Run pair-syntheses in parallel. A failed pair (worker crash, timeout,
    // network) does NOT abort the round — its two original findings pass
    // through to the next round unchanged so no information is lost.
    const settled = await Promise.allSettled(
      pairs.map(async (pair, i) => {
        const pairLabel = `${roundLabel}-pair${i + 1}`;
        const workerResult = await agentFactory.spawnWorker(
          this.synthesizerAgent,
          formatFindings(pair, goal),
          ctx,
          { name: `synthesizer-${pairLabel}` }
        );
        return { pair, pairLabel, result: workerResult.result };
      })
    );

    let fulfilledCount = 0;
    const intermediates: Finding[] = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      const pair = pairs[i];
      const pairLabel = `${roundLabel}-pair${i + 1}`;

      if (s.status === "fulfilled") {
        fulfilledCount += 1;
        const { result } = s.value;
        const allSources = pair.flatMap((f) => f.sources);
        addNode(ctx, {
          type: "synthesis",
          parentId: roundNode.id,
          content: result,
          source: `tournament-${pairLabel}`,
          metadata: { inputCount: pair.length },
        });
        intermediates.push({
          question: `Intermediate synthesis (${pairLabel})`,
          answer: result,
          sources: [...new Set(allSources)],
        });
      } else {
        const errMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
        log("synthesis", `${pairLabel} failed, passing through ${pair.length} findings: ${errMsg}`);
        addNode(ctx, {
          type: "synthesis",
          parentId: roundNode.id,
          content: null,
          source: `tournament-${pairLabel}`,
          summary: `[failed] ${pairLabel}: ${errMsg.slice(0, 200)}`,
          metadata: { inputCount: pair.length, failed: true, error: errMsg },
        });
        // Pass-through: original findings continue to the next round unchanged.
        intermediates.push(...pair);
      }
    }

    if (fulfilledCount === 0) {
      throw new Error(
        `Tournament ${roundLabel} aborted: all ${pairs.length} pair-syntheses failed`,
      );
    }

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

// -- External Strategy Loader -------------------------------------------------

/**
 * Load a custom synthesis strategy from an external JS file.
 * The file must export: { synthesize(goal, findings, ctx, agentFactory) => Promise<string> }
 */
export async function loadExternalStrategy(jsPath: string): Promise<SynthesisStrategy> {
  const { pathToFileURL } = await import("node:url");
  const fileUrl = pathToFileURL(jsPath).href;
  const mod = await import(fileUrl);

  if (typeof mod.synthesize !== "function") {
    throw new Error(`Strategy file "${jsPath}" must export a 'synthesize' function`);
  }

  return {
    synthesize: mod.synthesize,
  };
}

// -- Strategy Factory ---------------------------------------------------------

/**
 * Wrap a strategy so its final report goes through dedupeSources before
 * being returned. Applied uniformly to tournament, single-pass, and
 * externally-loaded strategies — synthesis prompt obedience is stochastic
 * (see bench/baseline/skynet-genesis/{v1,v2}/), so we enforce dedup in code.
 */
function withPostProcess(inner: SynthesisStrategy): SynthesisStrategy {
  return {
    async synthesize(goal, findings, ctx, agentFactory) {
      const raw = await inner.synthesize(goal, findings, ctx, agentFactory);
      const { result, deduped } = dedupeSources(raw);
      if (deduped > 0) {
        log("synthesis", `dedupeSources removed ${deduped} duplicate source entries`);
      }
      return result;
    },
  };
}

export function createSynthesisStrategy(
  config: { default: string; strategies: Record<string, Record<string, unknown>> }
): SynthesisStrategy {
  const strategyName = config.default;
  const strategyConfig = config.strategies[strategyName] || {};

  // Check for external strategy file
  if (typeof strategyConfig.file === "string") {
    // Return a lazy-loading proxy that loads on first call
    let loaded: SynthesisStrategy | null = null;
    return withPostProcess({
      async synthesize(goal, findings, ctx, agentFactory) {
        if (!loaded) {
          loaded = await loadExternalStrategy(strategyConfig.file as string);
        }
        return loaded.synthesize(goal, findings, ctx, agentFactory);
      },
    });
  }

  switch (strategyName) {
    case "tournament":
      return withPostProcess(new TournamentSynthesis(
        (strategyConfig.synthesizerAgent as string) || "synthesizer",
        (strategyConfig.maxDepth as number) || 3,
        (strategyConfig.baseCaseSize as number) || 3,
      ));
    case "single-pass":
      return withPostProcess(new SinglePassSynthesis(
        (strategyConfig.synthesizerAgent as string) || "synthesizer",
      ));
    default:
      // Fall back to tournament
      return withPostProcess(new TournamentSynthesis("synthesizer", 3, 3));
  }
}

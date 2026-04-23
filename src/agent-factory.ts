import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "./context.js";
import type { SwarmConfig, AgentDefinition } from "./config/types.js";
import { spawnAgent, buildWorkerEnv } from "./worker-pool.js";
import type { WorkerResultMessage } from "./worker-pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class AgentFactory {
  constructor(
    private config: SwarmConfig,
  ) {}

  /** Get an agent definition by name, throws if not found */
  getAgent(name: string): AgentDefinition {
    const def = this.config.agents[name];
    if (!def) throw new Error(`Agent "${name}" is not defined in config`);
    return def;
  }

  /** Spawn a worker-process agent using the agent definition from config */
  async spawnWorker(
    agentName: string,
    userMessage: string,
    ctx: Context,
    overrides?: Partial<{ maxIterations: number; tools: Array<{ type: string; vectorKey?: string; basePath?: string }>; name: string }>
  ): Promise<WorkerResultMessage> {
    const def = this.getAgent(agentName);
    const prompt = this.readPrompt(def);
    const vectorKey = ctx.store.vectorKey as string | undefined;
    const basePath = ctx.store.basePath as string | undefined;

    // Build tool configs from agent definition
    const tools = overrides?.tools ?? def.tools.map((t) => {
      if (t === "search_code" && vectorKey) {
        return { type: t, vectorKey };
      }
      if ((t === "read_file" || t === "list_files" || t === "grep_code") && basePath) {
        return { type: t, basePath };
      }
      return { type: t };
    });

    const baseEnv = buildWorkerEnv();
    // Agent-level model/temperature overrides win over global defaults.
    const resolvedModel = this.resolveModel(agentName);
    const resolvedTemperature = this.resolveTemperature(agentName);

    return spawnAgent({
      name: overrides?.name ?? def.name,
      systemPrompt: prompt,
      userMessage,
      maxIterations: overrides?.maxIterations ?? def.limits.maxIterations,
      allowTextResponse: def.allowTextResponse,
      sessionId: ctx.sessionId,
      tools,
      configPackageDir: this.config.configPackageDir,
      // Forward tool configs unconditionally so YAML overrides reach the worker.
      toolsConfig: this.config.tools as Record<string, { enabled: boolean; file?: string; terminates?: boolean; defaults: Record<string, unknown> }>,
      toolCallBudget: def.limits.toolCallBudget,
      maxNudges: def.limits.maxNudges,
      tokenBudgetFraction: def.limits.tokenBudgetFraction,
      toolBatchSize: this.config.global.limits.toolBatchSize,
      temperature: resolvedTemperature,
      tokenBudgetConfig: {
        responseReserveFraction: this.config.global.tokenBudget.responseReserveFraction,
        responseReserveMax: this.config.global.tokenBudget.responseReserveMax,
        compactionTrigger: this.config.global.tokenBudget.compactionTrigger,
        compactionTarget: this.config.global.tokenBudget.compactionTarget,
      },
      vectorKvBaseUrl: this.config.global.vectorKvBaseUrl,
      dbPath: this.config.global.dbPath,
      env: {
        ...baseEnv,
        MODEL_NAME: resolvedModel,
      },
      extraEnv: def.env,
    });
  }

  /** Read and return a system prompt from file or inline */
  readPrompt(def: AgentDefinition): string {
    if (def.systemPrompt.startsWith("inline:")) {
      return def.systemPrompt.slice(7).trim();
    }
    // If the path is absolute, read directly; otherwise resolve relative to src/
    const promptPath = path.isAbsolute(def.systemPrompt)
      ? def.systemPrompt
      : path.resolve(__dirname, def.systemPrompt);
    return fs.readFileSync(promptPath, "utf-8");
  }

  /** Resolve the effective model for an agent (agent override or global default) */
  resolveModel(agentName: string): string {
    const def = this.getAgent(agentName);
    return def.model ?? this.config.global.model;
  }

  /** Resolve the effective temperature for an agent */
  resolveTemperature(agentName: string): number {
    const def = this.getAgent(agentName);
    return def.temperature ?? this.config.global.temperature;
  }
}

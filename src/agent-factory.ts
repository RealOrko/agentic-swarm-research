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
    overrides?: Partial<{ maxIterations: number; tools: Array<{ type: string; vectorKey?: string }>; name: string }>
  ): Promise<WorkerResultMessage> {
    const def = this.getAgent(agentName);
    const prompt = this.readPrompt(def);
    const vectorKey = ctx.store.vectorKey as string | undefined;

    // Build tool configs from agent definition
    const tools = overrides?.tools ?? def.tools.map((t) => {
      if (t === "search_code" && vectorKey) {
        return { type: t, vectorKey };
      }
      return { type: t };
    });

    return spawnAgent({
      name: overrides?.name ?? def.name,
      systemPrompt: prompt,
      userMessage,
      maxIterations: overrides?.maxIterations ?? def.limits.maxIterations,
      allowTextResponse: def.allowTextResponse,
      sessionId: ctx.sessionId,
      tools,
      env: buildWorkerEnv(),
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

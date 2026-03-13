import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolHandler } from "./agent-loop.js";
import type { Context } from "./context.js";
import type { SwarmConfig, ToolConfig } from "./config/types.js";
import type { AgentFactory } from "./agent-factory.js";
import { createWebSearchTool } from "./tools/webSearch.js";
import { createFetchPageTool } from "./tools/fetchPage.js";
import { createGrepCodeTool } from "./tools/grepCode.js";
import { createSearchCodeTool } from "./tools/searchCode.js";
import { createQueryKnowledgeTool } from "./tools/queryKnowledge.js";
import { createSubmitFindingTool } from "./tools/submitFinding.js";
import { createSubmitCritiqueTool } from "./tools/submitCritique.js";
import { submitReportTool } from "./tools/submitReport.js";
import {
  loadExternalTool,
  buildExternalToolContext,
  wrapExternalTool,
} from "./tool-loader.js";
import type { ExternalToolModule } from "./tool-loader.js";
import { log as centralLog } from "./logger.js";

export interface ToolRuntimeContext {
  ctx: Context;
  vectorKey?: string;
  agentFactory?: AgentFactory;
}

export type ToolHandlerFactory = (
  config: ToolConfig,
  runtimeContext: ToolRuntimeContext
) => ToolHandler;

export class ToolRegistry {
  private factories = new Map<string, ToolHandlerFactory>();
  /** Cache of loaded external tool modules (path → module) */
  private externalModules = new Map<string, ExternalToolModule>();

  register(name: string, factory: ToolHandlerFactory): void {
    this.factories.set(name, factory);
  }

  /**
   * Load and register an external JS tool file.
   * The file must export { schema, handler }.
   */
  async registerExternal(
    name: string,
    jsPath: string,
    terminates: boolean = false,
  ): Promise<void> {
    let mod = this.externalModules.get(jsPath);
    if (!mod) {
      mod = await loadExternalTool(jsPath, name);
      this.externalModules.set(jsPath, mod);
    }

    this.register(name, (tc, rt) => {
      return wrapExternalTool(
        mod!,
        tc.defaults,
        terminates,
        () =>
          buildExternalToolContext(
            rt.ctx,
            tc.defaults,
            (msg) => centralLog(name, msg),
            rt.agentFactory,
            rt.vectorKey,
          ),
      );
    });
  }

  /**
   * Load all external tools defined in the config's tools section.
   * Tools with a `file` field are loaded from disk.
   */
  async registerExternalsFromConfig(config: SwarmConfig): Promise<void> {
    for (const [name, tool] of Object.entries(config.tools)) {
      if (tool.file) {
        await this.registerExternal(name, tool.file, tool.terminates ?? false);
      }
    }
  }

  registerBuiltins(config: SwarmConfig): void {
    // Data tools - read defaults from config.tools
    this.register("web_search", (tc) =>
      createWebSearchTool({
        topResults: (tc.defaults.topResults as number) ?? 8,
        searxngUrl: (tc.defaults.searxngUrl as string) ?? "http://localhost:8080",
      })
    );

    this.register("fetch_page", (tc) =>
      createFetchPageTool({
        maxContentChars: (tc.defaults.maxContentChars as number) ?? 4000,
        timeoutMs: (tc.defaults.timeoutMs as number) ?? 10000,
        maxRetries: (tc.defaults.maxRetries as number) ?? 3,
      })
    );

    this.register("grep_code", (tc) =>
      createGrepCodeTool({
        maxResults: (tc.defaults.maxResults as number) ?? 30,
        maxResultsCap: (tc.defaults.maxResultsCap as number) ?? 100,
        timeoutMs: (tc.defaults.timeoutMs as number) ?? 15000,
      })
    );

    this.register("search_code", (tc, rt) => {
      const vectorKey = rt.vectorKey;
      if (!vectorKey) {
        // Return a stub that reports the error when called
        return {
          definition: {
            type: "function" as const,
            function: {
              name: "search_code",
              description: "Semantic search over pre-indexed codebase (requires vectorKey).",
              parameters: { type: "object" as const, properties: {}, required: [] },
            },
          },
          handler: async () => ({ error: "search_code requires vectorKey to be configured" }),
        };
      }
      return createSearchCodeTool({
        vectorKey,
        numResults: (tc.defaults.numResults as number) ?? 5,
        numResultsCap: (tc.defaults.numResultsCap as number) ?? 20,
        timeoutMs: (tc.defaults.timeoutMs as number) ?? 30000,
      });
    });

    this.register("query_knowledge", (tc) =>
      createQueryKnowledgeTool({
        topK: (tc.defaults.topK as number) ?? 5,
        topKCap: (tc.defaults.topKCap as number) ?? 10,
      })
    );

    // Terminal tools - no config needed
    this.register("submit_finding", () => createSubmitFindingTool());
    this.register("submit_critique", () => createSubmitCritiqueTool());
    this.register("submit_final_report", () => submitReportTool);
  }

  resolve(
    toolNames: string[],
    config: SwarmConfig,
    runtimeContext: ToolRuntimeContext
  ): ToolHandler[] {
    const handlers: ToolHandler[] = [];
    for (const name of toolNames) {
      const factory = this.factories.get(name);
      if (!factory) {
        // Skip unknown tools (meta-tools / bridge tools are handled separately)
        continue;
      }
      const toolConfig = config.tools[name] ?? { enabled: true, defaults: {} };
      if (toolConfig.enabled === false) continue;
      handlers.push(factory(toolConfig, runtimeContext));
    }
    return handlers;
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  getDefinition(name: string, config: SwarmConfig, runtimeContext: ToolRuntimeContext): ChatCompletionTool | null {
    const factory = this.factories.get(name);
    if (!factory) return null;
    const toolConfig = config.tools[name] ?? { enabled: true, defaults: {} };
    const handler = factory(toolConfig, runtimeContext);
    return handler.definition;
  }
}

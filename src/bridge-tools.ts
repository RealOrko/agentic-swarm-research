/**
 * Auto-generated bridge tools from topology edges.
 *
 * When a topology edge says { from: A, to: B, via: my_tool }, the runtime
 * creates a tool called `my_tool` that spawns agent B as a worker and returns
 * B's result to A. This eliminates the need for hand-coded meta-tools like
 * research.ts, synthesize.ts, and critique.ts.
 *
 * The tool schema comes from (in priority order):
 *   1. tools.<name>.file — external JS file exports { schema, handler }
 *   2. tools.<name>.schema — inline schema in YAML
 *   3. topology.edges[].toolSchema — inline schema on the edge
 *   4. Default: { question: string }
 *
 * Special cases:
 *   - Synthesis edges (with strategy config) trigger the synthesis strategy
 *   - Terminal tools (terminates: true) end the agent loop
 */

import type { ToolHandler } from "./agent-loop.js";
import type { Context } from "./context.js";
import type { AgentFactory } from "./agent-factory.js";
import type { SwarmConfig, TopologyEdge, ToolConfig } from "./config/types.js";
import type { SynthesisStrategy, Finding } from "./synthesis/strategies.js";
import { addNode, getRootId } from "./context.js";
import { log } from "./logger.js";

/** Default schema for bridge tools that spawn agents */
const DEFAULT_BRIDGE_SCHEMA = {
  type: "object" as const,
  properties: {
    question: {
      type: "string",
      description: "The question or task to delegate to the agent",
    },
  },
  required: ["question"],
};

/**
 * Generate bridge tools for all topology edges originating from a given agent.
 * Returns ToolHandler[] that the agent can use.
 */
export function generateBridgeTools(
  agentName: string,
  config: SwarmConfig,
  agentFactory: AgentFactory,
  synthesisStrategy?: SynthesisStrategy,
): ToolHandler[] {
  const edges = config.topology.edges.filter((e) => e.from === agentName);
  const handlers: ToolHandler[] = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    // Skip feedback edges (from target back to source)
    if (edge.condition) continue;

    // Don't generate duplicate tools for the same 'via'
    if (seen.has(edge.via)) continue;
    seen.add(edge.via);

    const toolConfig = config.tools[edge.via];

    // Skip tools that have an external file — those are handled by the ToolRegistry
    if (toolConfig?.file) continue;

    // Skip tools already registered as builtins with no spawns/strategy override
    // (This ensures backward compat — builtins work as before unless overridden)

    // Check if this is a synthesis edge
    if (edge.strategy) {
      if (synthesisStrategy) {
        handlers.push(
          createSynthesisBridgeTool(edge, config, agentFactory, synthesisStrategy)
        );
      }
      continue;
    }

    // Create a standard bridge tool that spawns the target agent
    handlers.push(createBridgeTool(edge, config, agentFactory, toolConfig));
  }

  return handlers;
}

/**
 * Create a bridge tool that spawns a target agent for a topology edge.
 */
function createBridgeTool(
  edge: TopologyEdge,
  config: SwarmConfig,
  agentFactory: AgentFactory,
  toolConfig?: ToolConfig,
): ToolHandler {
  const toolName = edge.via;
  const targetAgent = edge.to;
  const schema = resolveSchema(edge, toolConfig, toolName, targetAgent);

  return {
    definition: {
      type: "function",
      function: schema,
    },

    handler: async (
      args: Record<string, unknown>,
      ctx: Context,
    ): Promise<unknown> => {
      // Build user message from args
      const userMessage = buildUserMessage(args, toolName);

      // Create sub_question node for tracking
      const content = typeof args.question === "string"
        ? args.question
        : JSON.stringify(args);
      const sqNode = addNode(ctx, {
        type: "sub_question",
        parentId: ctx.store._rootId as string,
        content,
        source: toolName,
        summary: content.length > 300 ? content.slice(0, 300) + "..." : content,
      });

      const workerResult = await agentFactory.spawnWorker(
        targetAgent,
        userMessage,
        ctx,
      );

      // Parse result
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(workerResult.result);
      } catch {
        parsed = { answer: workerResult.result, sources: [] };
      }

      // Auto-collect sources from events if not provided
      let sources = (parsed.sources as string[]) || [];
      if (sources.length === 0) {
        sources = collectSourcesFromEvents(ctx);
      }

      // Create finding node
      const findingContent = (parsed.answer as string) || workerResult.result;
      const findingNode = addNode(ctx, {
        type: "finding",
        parentId: sqNode.id,
        content: findingContent,
        source: toolName,
        metadata: { sources },
      });

      return { ...parsed, _nodeId: findingNode.id };
    },
  };
}

/**
 * Create a synthesis bridge tool that uses the configured synthesis strategy.
 */
function createSynthesisBridgeTool(
  edge: TopologyEdge,
  config: SwarmConfig,
  agentFactory: AgentFactory,
  strategy: SynthesisStrategy,
): ToolHandler {
  const toolName = edge.via;

  return {
    definition: {
      type: "function",
      function: {
        name: toolName,
        description:
          "Synthesize all research findings into a coherent summary. Automatically collects findings from the session — no parameters needed.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },

    handler: async (
      args: Record<string, unknown>,
      ctx: Context,
    ): Promise<unknown> => {
      const goal = (ctx.store.goal as string) || "Unknown goal";

      const findingNodes = ctx.db.getNodesByType(ctx.sessionId, "finding");
      const findings: Finding[] = [];
      for (const node of findingNodes) {
        if (node.content) {
          findings.push({
            question: node.summary || "Research finding",
            answer: node.content,
            sources: (node.metadata.sources as string[]) || [],
          });
        }
      }

      if (findings.length === 0) {
        return { error: "No findings available to synthesize. Run research first." };
      }

      const result = await strategy.synthesize(goal, findings, ctx, agentFactory);

      const synthNode = addNode(ctx, {
        type: "synthesis",
        parentId: ctx.store._rootId as string,
        content: result,
        source: toolName,
        summary: result.length > 300 ? result.slice(0, 300) + "..." : result,
      });

      return { synthesis: result, _nodeId: synthNode.id };
    },
  };
}

/**
 * Create a terminal tool that ends the agent loop.
 * If no custom handler is provided, it's a passthrough that returns the args.
 */
export function createTerminalBridgeTool(
  toolName: string,
  toolConfig?: ToolConfig,
): ToolHandler {
  const schemaParams = toolConfig?.schema ?? {
    type: "object",
    properties: {},
  };

  return {
    definition: {
      type: "function",
      function: {
        name: toolName,
        description: `Submit final result and end the session.`,
        parameters: schemaParams,
      },
    },
    terminates: true,
    handler: async (args: Record<string, unknown>): Promise<unknown> => {
      return args;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveSchema(
  edge: TopologyEdge,
  toolConfig: ToolConfig | undefined,
  toolName: string,
  targetAgent: string,
): { name: string; description: string; parameters: Record<string, unknown> } {
  // Priority 1: inline schema in tool config
  if (toolConfig?.schema) {
    const s = toolConfig.schema;
    return {
      name: toolName,
      description: (s.description as string) || `Delegate to ${targetAgent}`,
      parameters: (s.parameters as Record<string, unknown>) || DEFAULT_BRIDGE_SCHEMA,
    };
  }

  // Priority 2: inline schema on the edge
  if (edge.toolSchema) {
    return {
      name: toolName,
      description: (edge.toolSchema.description as string) || `Delegate to ${targetAgent}`,
      parameters: (edge.toolSchema.parameters as Record<string, unknown>) || DEFAULT_BRIDGE_SCHEMA,
    };
  }

  // Priority 3: default schema
  return {
    name: toolName,
    description: `Delegate a task to the ${targetAgent} agent. Returns the agent's result.`,
    parameters: DEFAULT_BRIDGE_SCHEMA,
  };
}

function buildUserMessage(args: Record<string, unknown>, toolName: string): string {
  // If the tool has a 'question' param, use it as the user message
  if (typeof args.question === "string") {
    return args.question;
  }
  // If there's a 'goal' and 'synthesis' (critique-style), build a review prompt
  if (typeof args.goal === "string" && typeof args.synthesis === "string") {
    return `Original research goal: ${args.goal}\n\nSynthesis to review:\n\n${args.synthesis}`;
  }
  // Fall back to JSON stringification of all args
  return JSON.stringify(args, null, 2);
}

function collectSourcesFromEvents(ctx: Context): string[] {
  const searchEvents = ctx.db.queryEvents(ctx.sessionId, "tool_result", "web_search");
  const searchUrls = searchEvents.flatMap((e) => {
    const output = e.output as Record<string, unknown>;
    const results = (output?.results as Array<Record<string, unknown>>) || [];
    return results.map((r) => r.url as string).filter(Boolean);
  });

  const fetchEvents = ctx.db.queryEvents(ctx.sessionId, "tool_call", "fetch_page");
  const fetchedUrls = fetchEvents
    .map((e) => (e.input as Record<string, unknown>)?.url as string)
    .filter(Boolean);

  return [...new Set([...fetchedUrls, ...searchUrls])];
}

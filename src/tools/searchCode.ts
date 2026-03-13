import { execFileSync } from "node:child_process";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { addNode, getRootId } from "../context.js";

export interface SearchCodeToolConfig {
  vectorKey: string;
  numResults: number;
  numResultsCap: number;
  timeoutMs: number;
}

export function createSearchCodeTool(config: SearchCodeToolConfig | string): ToolHandler {
  const cfg = typeof config === "string"
    ? { vectorKey: config, numResults: 5, numResultsCap: 20, timeoutMs: 30000 }
    : config;

  return {
    definition: {
      type: "function",
      function: {
        name: "search_code",
        description:
          "Semantic search over the pre-indexed codebase. Returns the most relevant code chunks for a natural-language query. Use this for questions about how code works, what patterns exist, finding implementations, etc.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Natural-language query describing what you're looking for in the codebase",
            },
            num_results: {
              type: "number",
              description:
                "Number of results to return (default 5, max 20)",
            },
          },
          required: ["query"],
        },
      },
    },

    handler: async (
      args: Record<string, unknown>,
      ctx: Context
    ): Promise<unknown> => {
      const query = args.query as string;
      const k = Math.min(Math.max((args.num_results as number) || cfg.numResults, 1), cfg.numResultsCap);

      try {
        const output = execFileSync(
          "vector-kv",
          ["get", cfg.vectorKey, "-q", query, "-k", String(k)],
          { encoding: "utf-8", timeout: cfg.timeoutMs }
        );

        const results = JSON.parse(output) as Array<{
          content: string;
          distance: number;
        }>;

        const formatted = results.map((r) => ({
          content: r.content,
          relevance: Math.round((1 - r.distance) * 100) / 100,
        }));

        // Create a finding node so synthesize_findings picks up code search results
        const content = formatted
          .map((r) => r.content)
          .join("\n\n---\n\n");

        addNode(ctx, {
          type: "finding",
          parentId: getRootId(ctx),
          content,
          source: "search_code",
          summary: `Code search: ${query}`,
          metadata: { query, vectorKvKey: cfg.vectorKey, resultCount: formatted.length },
        });

        return { query, results: formatted };
      } catch (err) {
        return {
          query,
          error: err instanceof Error ? err.message : String(err),
          results: [],
        };
      }
    },
  };
}

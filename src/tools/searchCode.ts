import { execFileSync } from "node:child_process";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { addNode, getRootId } from "../context.js";

export function createSearchCodeTool(vectorKvKey: string): ToolHandler {
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
      const k = Math.min(Math.max((args.num_results as number) || 5, 1), 20);

      try {
        const output = execFileSync(
          "vector-kv",
          ["get", vectorKvKey, "-q", query, "-k", String(k)],
          { encoding: "utf-8", timeout: 30000 }
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
          metadata: { query, vectorKvKey, resultCount: formatted.length },
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

import { execFileSync } from "node:child_process";
import type { ToolHandler } from "../agent-loop.js";

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

    handler: async (args: Record<string, unknown>): Promise<unknown> => {
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

        return {
          query,
          results: results.map((r) => ({
            content: r.content,
            relevance: Math.round((1 - r.distance) * 100) / 100,
          })),
        };
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

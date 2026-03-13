import "dotenv/config";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";

const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:8080";

interface SearXNGResult {
  title: string;
  url: string;
  content: string;
  engine: string;
}

interface SearXNGResponse {
  results: SearXNGResult[];
}

export interface WebSearchToolConfig {
  topResults: number;
  searxngUrl: string;
}

export function createWebSearchTool(config: WebSearchToolConfig): ToolHandler {
  return {
    definition: {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the web. Returns a list of results with titles, URLs, and snippets.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query",
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
      const params = new URLSearchParams({
        q: query,
        format: "json",
        categories: "general",
      });

      try {
        const res = await fetch(`${config.searxngUrl}/search?${params}`);

        if (!res.ok) {
          return {
            query,
            error: `SearXNG returned ${res.status}: ${res.statusText}`,
            results: [],
          };
        }

        const data = (await res.json()) as SearXNGResponse;

        const topResults = data.results.slice(0, config.topResults).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content,
          engine: r.engine,
        }));

        // Auto-index search snippets into knowledge store
        if (ctx.knowledgeStore) {
          for (const r of topResults) {
            if (r.snippet) {
              ctx.knowledgeStore
                .index(r.snippet, "search_snippet", r.url, {
                  title: r.title,
                  query,
                })
                .catch(() => {});
            }
          }
        }

        return { query, results: topResults };
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

export const webSearchTool = createWebSearchTool({
  topResults: 8,
  searxngUrl: SEARXNG_URL,
});

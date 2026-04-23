import "dotenv/config";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { addNode, getRootId } from "../context.js";

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

        const nodeContent = topResults
          .map((r) => `${r.title}\n${r.url}\n${r.snippet}`)
          .join("\n\n---\n\n");
        const node = addNode(ctx, {
          type: "search_result",
          parentId: getRootId(ctx),
          content: nodeContent,
          source: "web_search",
          summary: `web_search "${query}" → ${topResults.length} result${topResults.length === 1 ? "" : "s"}`,
          metadata: { query, resultCount: topResults.length },
        });

        return { query, results: topResults, _nodeId: node.id };
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

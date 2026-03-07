import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";

/** Strip HTML tags and decode common entities */
function stripHtml(html: string): string {
  // Remove script/style blocks entirely
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Replace block-level tags with newlines
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|br\s*\/?)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Extract <title> content from HTML */
function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]).slice(0, 200) : "";
}

export const fetchPageTool: ToolHandler = {
  definition: {
    type: "function",
    function: {
      name: "fetch_page",
      description:
        "Fetch a web page and extract its text content. Use this to read the full content of URLs found in search results. Returns the page title and text content (truncated to ~4000 characters).",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
        },
        required: ["url"],
      },
    },
  },

  handler: async (
    args: Record<string, unknown>,
    ctx: Context
  ): Promise<unknown> => {
    const url = args.url as string;
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; ResearchBot/1.0)",
            Accept: "text/html,application/xhtml+xml,text/plain",
          },
        });
        clearTimeout(timeout);

        if (!res.ok) {
          // Retry on 429 or 5xx
          if ((res.status === 429 || res.status >= 500) && attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
            continue;
          }
          return { url, error: `HTTP ${res.status}: ${res.statusText}`, content: "" };
        }

        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("text/") && !contentType.includes("application/xhtml")) {
          return { url, error: `Non-text content type: ${contentType}`, content: "" };
        }

        const html = await res.text();
        const title = extractTitle(html);
        let content = stripHtml(html);

        // Truncate to ~4000 chars
        if (content.length > 4000) {
          content = content.slice(0, 4000) + "\n\n[...truncated]";
        }

        // Auto-index into knowledge store
        if (ctx.knowledgeStore) {
          ctx.knowledgeStore
            .index(content, "web_page", url, { title })
            .catch(() => {});
        }

        return { url, title, content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Retry on timeout/network errors
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
          continue;
        }
        return { url, error: message, content: "" };
      }
    }

    return { url, error: "Max retries exceeded", content: "" };
  },
};

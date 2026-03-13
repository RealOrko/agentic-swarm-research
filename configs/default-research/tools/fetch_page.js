// Fetch page tool — retrieves and extracts text from web pages
export const schema = {
  type: "function",
  function: {
    name: "fetch_page",
    description:
      "Fetch a web page and extract its text content. Returns the page title and text content.",
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
};

function stripHtml(html) {
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|br\s*\/?)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]).slice(0, 200) : "";
}

export async function handler(args, ctx) {
  const url = args.url;
  const maxContentChars = ctx.config.maxContentChars || 4000;
  const timeoutMs = ctx.config.timeoutMs || 10000;
  const maxRetries = ctx.config.maxRetries || 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const res = await ctx.fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ResearchBot/1.0)",
          Accept: "text/html,application/xhtml+xml,text/plain",
        },
      });
      clearTimeout(timeout);

      if (!res.ok) {
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

      if (content.length > maxContentChars) {
        content = content.slice(0, maxContentChars) + "\n\n[...truncated]";
      }

      if (ctx.knowledgeStore) {
        ctx.knowledgeStore.index(content, "web_page", url, { title }).catch(() => {});
      }

      return { url, title, content };
    } catch (err) {
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      return { url, error: err.message || String(err), content: "" };
    }
  }

  return { url, error: "Max retries exceeded", content: "" };
}

import fs from "node:fs";
import path from "node:path";
import slugify from "slugify";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { serializeTree, getTreeTokens, getRootId } from "../context.js";

export function writeReport(
  report: string,
  ctx: Context
): { reportPath: string; contextPath: string } {
  const goal = (ctx.store.goal as string) || "research";

  const date = new Date().toISOString().split("T")[0];
  const slug = slugify(goal, { lower: true, strict: true }).slice(0, 60);
  const dirName = `${date}-${slug}`;

  const resultsDir = path.join(process.cwd(), "results", dirName);
  fs.mkdirSync(resultsDir, { recursive: true });

  const reportPath = path.join(resultsDir, "report.md");
  fs.writeFileSync(reportPath, report, "utf-8");

  // Serialize context with tree structure and metrics (queried from DB)
  const eventCounts = ctx.db.countEventsByType(ctx.sessionId);
  const totalEvents = ctx.db.countEvents(ctx.sessionId);

  const contextData = {
    sessionId: ctx.sessionId,
    store: ctx.store,
    tree: serializeTree(ctx),
    metrics: {
      totalTreeNodes: Object.keys(serializeTree(ctx).nodes).length,
      treeTokens: getTreeTokens(ctx),
      totalEvents,
      eventCounts,
    },
  };

  const contextPath = path.join(resultsDir, "context.json");
  fs.writeFileSync(contextPath, JSON.stringify(contextData, null, 2), "utf-8");

  return { reportPath, contextPath };
}

export const submitReportTool: ToolHandler = {
  terminates: true,
  definition: {
    type: "function",
    function: {
      name: "submit_final_report",
      description:
        "Submit the final research report. This writes the report as a markdown file to the results folder and ends the research session.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  handler: async (
    args: Record<string, unknown>,
    ctx: Context
  ): Promise<unknown> => {
    // Auto-pull the latest synthesis from the context DB
    const syntheses = ctx.db.getNodesByType(ctx.sessionId, "synthesis")
      .filter((n) => n.content && n.content.length > 100)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const report = syntheses.length > 0
      ? syntheses[0].content!
      : "No synthesis available. Research findings were collected but not synthesized.";

    const { reportPath, contextPath } = writeReport(report, ctx);

    return {
      reportPath,
      contextPath,
      message: `Report written to ${reportPath}`,
    };
  },
};

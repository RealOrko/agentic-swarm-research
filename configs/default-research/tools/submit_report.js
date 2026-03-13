// Submit report — terminal tool that writes the final report and ends the swarm
import fs from "node:fs";
import path from "node:path";
import slugify from "slugify";

export const schema = {
  type: "function",
  function: {
    name: "submit_final_report",
    description:
      "Submit the final research report. Writes the report as a markdown file and ends the session.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export async function handler(args, ctx) {
  const sessionCtx = ctx.ctx;
  const goal = sessionCtx.store.goal || "research";

  // Auto-pull the latest synthesis from the context DB
  const syntheses = sessionCtx.db
    .getNodesByType(sessionCtx.sessionId, "synthesis")
    .filter((n) => n.content && n.content.length > 100)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const report =
    syntheses.length > 0
      ? syntheses[0].content
      : "No synthesis available. Research findings were collected but not synthesized.";

  const date = new Date().toISOString().split("T")[0];
  const slug = slugify(goal, { lower: true, strict: true }).slice(0, 60);
  const dirName = `${date}-${slug}`;

  const resultsDir = path.join(process.cwd(), "results", dirName);
  fs.mkdirSync(resultsDir, { recursive: true });

  const reportPath = path.join(resultsDir, "report.md");
  fs.writeFileSync(reportPath, report, "utf-8");

  // Serialize context
  const eventCounts = sessionCtx.db.countEventsByType(sessionCtx.sessionId);
  const totalEvents = sessionCtx.db.countEvents(sessionCtx.sessionId);

  const contextData = {
    sessionId: sessionCtx.sessionId,
    store: sessionCtx.store,
    metrics: { totalEvents, eventCounts },
  };

  const contextPath = path.join(resultsDir, "context.json");
  fs.writeFileSync(contextPath, JSON.stringify(contextData, null, 2), "utf-8");

  return {
    reportPath,
    contextPath,
    message: `Report written to ${reportPath}`,
  };
}

import type { Context } from "../context.js";

/**
 * Workflow-aware nudge strategy for the orchestrator.
 * Checks which tools have been called and guides the orchestrator
 * to the next step in the research workflow.
 */
export function orchestratorNudgeStrategy(ctx: Context, _agentName: string): string | null {
  const hasSynthesis = ctx.db.hasEvent(ctx.sessionId, "tool_call", "synthesize_findings");
  const hasCritique = ctx.db.hasEvent(ctx.sessionId, "tool_call", "critique");
  const hasReport = ctx.db.hasEvent(ctx.sessionId, "tool_call", "submit_final_report");

  if (!hasSynthesis) {
    return "Call synthesize_findings now. It takes no arguments — just call it.";
  } else if (!hasCritique) {
    return "Call critique now with the goal and the synthesis text.";
  } else if (!hasReport) {
    return "Call submit_final_report now. It takes no arguments — just call it.";
  }

  return null;
}

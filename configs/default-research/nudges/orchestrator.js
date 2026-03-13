// Orchestrator nudge strategy — guides the orchestrator through the research workflow
export function nudge(ctx, agentName) {
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

import type { TopologyEdge } from "./config/types.js";

export type TopologyGraph = Map<string, TopologyEdge[]>;

/** Build an adjacency list from topology edges */
export function buildTopologyGraph(edges: TopologyEdge[]): TopologyGraph {
  const graph: TopologyGraph = new Map();

  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, []);
    if (!graph.has(edge.to)) graph.set(edge.to, []);
    graph.get(edge.from)!.push(edge);
  }

  return graph;
}

/** Get outbound edges from an agent */
export function getOutboundEdges(graph: TopologyGraph, agentName: string): TopologyEdge[] {
  return graph.get(agentName) || [];
}

/**
 * Safe expression evaluator for topology edge conditions.
 * Only supports simple patterns like:
 *   result.field === value
 *   result.field !== value
 *   result.field > number
 *   result.field < number
 *   result.field >= number
 *   result.field <= number
 *
 * Does NOT use eval(). Returns false on parse failure.
 */
export function evaluateCondition(expression: string, result: unknown): boolean {
  try {
    // Match pattern: result.path op value
    const match = expression.match(
      /^result\.(\w+(?:\.\w+)*)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/
    );
    if (!match) return false;

    const [, path, op, rawValue] = match;

    // Resolve the property path on the result
    let current: unknown = result;
    for (const key of path.split(".")) {
      if (current == null || typeof current !== "object") return false;
      current = (current as Record<string, unknown>)[key];
    }

    // Parse the comparison value
    let compareValue: unknown;
    const trimmed = rawValue.trim();
    if (trimmed === "true") compareValue = true;
    else if (trimmed === "false") compareValue = false;
    else if (trimmed === "null") compareValue = null;
    else if (trimmed === "undefined") compareValue = undefined;
    else if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) {
      compareValue = trimmed.slice(1, -1);
    } else if (!isNaN(Number(trimmed))) {
      compareValue = Number(trimmed);
    } else {
      compareValue = trimmed;
    }

    // Evaluate the comparison
    switch (op) {
      case "===": return current === compareValue;
      case "!==": return current !== compareValue;
      case "==": return current == compareValue;
      case "!=": return current != compareValue;
      case ">": return (current as number) > (compareValue as number);
      case "<": return (current as number) < (compareValue as number);
      case ">=": return (current as number) >= (compareValue as number);
      case "<=": return (current as number) <= (compareValue as number);
      default: return false;
    }
  } catch {
    return false;
  }
}

import { existsSync } from "node:fs";
import type {
  SwarmConfig,
  ValidationResult,
  ValidationError,
  TopologyEdge,
} from "./types.js";

/**
 * Validate a SwarmConfig.
 *
 * Returns { ok, errors, warnings } where `ok` is true only when errors is empty.
 */
export function validateConfig(config: SwarmConfig): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  const agentNames = new Set(Object.keys(config.agents));
  const toolNames = new Set(Object.keys(config.tools));

  // ── 1. Every agent in topology.edges exists in agents ──────────
  for (let i = 0; i < config.topology.edges.length; i++) {
    const edge = config.topology.edges[i];
    if (!agentNames.has(edge.from)) {
      errors.push({
        path: `topology.edges[${i}].from`,
        message: `Agent "${edge.from}" is not defined in agents`,
      });
    }
    if (!agentNames.has(edge.to)) {
      errors.push({
        path: `topology.edges[${i}].to`,
        message: `Agent "${edge.to}" is not defined in agents`,
      });
    }
  }

  // ── 2. Every tool in agent tool lists must be resolvable:
  //       defined in tools config, a topology edge 'via' (bridge tool),
  //       or the terminal tool ────────────────────────────────────────
  const topologyViaTools = new Set(config.topology.edges.map((e) => e.via));
  const terminalTool = config.topology.terminal.tool;
  for (const [agentName, agent] of Object.entries(config.agents)) {
    for (const tool of agent.tools) {
      if (
        !toolNames.has(tool) &&
        !topologyViaTools.has(tool) &&
        tool !== terminalTool
      ) {
        errors.push({
          path: `agents.${agentName}.tools`,
          message: `Tool "${tool}" is not defined in tools, topology edges, or as the terminal tool`,
        });
      }
    }
  }

  // ── 3. topology.entrypoint references a defined agent ──────────
  if (!agentNames.has(config.topology.entrypoint)) {
    errors.push({
      path: "topology.entrypoint",
      message: `Agent "${config.topology.entrypoint}" is not defined in agents`,
    });
  }

  // ── 4. topology.terminal.agent references a defined agent ──────
  if (!agentNames.has(config.topology.terminal.agent)) {
    errors.push({
      path: "topology.terminal.agent",
      message: `Agent "${config.topology.terminal.agent}" is not defined in agents`,
    });
  }

  // ── 5. Cycle detection: every cycle needs maxCycles on at least one edge ──
  const cycleErrors = detectUnboundedCycles(config.topology.edges, agentNames);
  errors.push(...cycleErrors);

  // ── 6. systemPrompt file paths must exist ──────────────────────
  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (agent.systemPrompt && !agent.systemPrompt.startsWith("inline:")) {
      if (!existsSync(agent.systemPrompt)) {
        errors.push({
          path: `agents.${agentName}.systemPrompt`,
          message: `File not found: "${agent.systemPrompt}"`,
        });
      }
    }
  }

  // ── 7. Sum of tokenBudgetFraction > 1.0 is a warning ──────────
  let fractionSum = 0;
  for (const agent of Object.values(config.agents)) {
    fractionSum += agent.limits.tokenBudgetFraction;
  }
  if (fractionSum > 1.0) {
    warnings.push({
      path: "agents.*.limits.tokenBudgetFraction",
      message: `Sum of tokenBudgetFraction across all agents is ${fractionSum.toFixed(2)} (> 1.0)`,
    });
  }

  // ── 8. Tool file paths must exist when specified ────────────────
  for (const [toolName, tool] of Object.entries(config.tools)) {
    if (tool.file && !existsSync(tool.file)) {
      errors.push({
        path: `tools.${toolName}.file`,
        message: `Tool file not found: "${tool.file}"`,
      });
    }
    // spawns must reference a defined agent
    if (tool.spawns && !agentNames.has(tool.spawns)) {
      errors.push({
        path: `tools.${toolName}.spawns`,
        message: `Agent "${tool.spawns}" is not defined in agents`,
      });
    }
  }

  // ── 9. Synthesis strategy file paths must exist ────────────────
  if (config.synthesis?.strategies) {
    for (const [stratName, strategy] of Object.entries(config.synthesis.strategies)) {
      if (typeof strategy.file === "string" && !existsSync(strategy.file)) {
        errors.push({
          path: `synthesis.strategies.${stratName}.file`,
          message: `Strategy file not found: "${strategy.file}"`,
        });
      }
    }
  }

  // ── 10. Agent nudge strategy file paths must exist ─────────────
  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (agent.nudgeStrategy && agent.nudgeStrategy !== "default" && !existsSync(agent.nudgeStrategy)) {
      errors.push({
        path: `agents.${agentName}.nudgeStrategy`,
        message: `Nudge strategy file not found: "${agent.nudgeStrategy}"`,
      });
    }
  }

  // ── 11. in-process agents can't have fan-out cardinality edges ──
  for (let i = 0; i < config.topology.edges.length; i++) {
    const edge = config.topology.edges[i];
    if (edge.cardinality === "fan-out") {
      const toAgent = config.agents[edge.to];
      if (toAgent && toAgent.execution === "in-process" && edge.cardinality === "fan-out") {
        errors.push({
          path: `topology.edges[${i}]`,
          message: `Agent "${edge.to}" uses in-process execution and cannot be the target of a fan-out edge (would block the event loop)`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

// ── Cycle detection ─────────────────────────────────────────────────

/**
 * Find cycles in the topology graph and check that every cycle
 * has at least one edge with a maxCycles constraint.
 */
function detectUnboundedCycles(
  edges: TopologyEdge[],
  agentNames: Set<string>
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Build adjacency list: agent -> list of { to, edgeIndex, hasMaxCycles }
  const adj = new Map<string, Array<{ to: string; edgeIndex: number; hasMaxCycles: boolean }>>();
  for (const name of agentNames) {
    adj.set(name, []);
  }

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const list = adj.get(edge.from);
    if (list) {
      list.push({
        to: edge.to,
        edgeIndex: i,
        hasMaxCycles: typeof edge.maxCycles === "number",
      });
    }
  }

  // DFS-based cycle detection
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const name of agentNames) {
    color.set(name, WHITE);
  }

  // Track the path for cycle reporting
  const path: Array<{ node: string; edgeIndex: number; hasMaxCycles: boolean }> = [];

  function dfs(node: string): void {
    color.set(node, GRAY);

    for (const neighbor of adj.get(node) || []) {
      if (color.get(neighbor.to) === GRAY) {
        // Found a cycle — check if any edge in the cycle has maxCycles
        const cycleStart = path.findIndex((p) => p.node === neighbor.to);
        const cycleEdges = [
          ...path.slice(cycleStart).map((p) => ({
            edgeIndex: p.edgeIndex,
            hasMaxCycles: p.hasMaxCycles,
          })),
          { edgeIndex: neighbor.edgeIndex, hasMaxCycles: neighbor.hasMaxCycles },
        ];

        const hasConstraint = cycleEdges.some((e) => e.hasMaxCycles);
        if (!hasConstraint) {
          const cycleNodes = path.slice(cycleStart).map((p) => p.node);
          cycleNodes.push(neighbor.to);
          errors.push({
            path: `topology.edges`,
            message: `Unbounded cycle detected: ${cycleNodes.join(" -> ")}. At least one edge in the cycle must have a maxCycles constraint`,
          });
        }
      } else if (color.get(neighbor.to) === WHITE) {
        path.push({ node: neighbor.to, edgeIndex: neighbor.edgeIndex, hasMaxCycles: neighbor.hasMaxCycles });
        dfs(neighbor.to);
        path.pop();
      }
    }

    color.set(node, BLACK);
  }

  for (const name of agentNames) {
    if (color.get(name) === WHITE) {
      path.length = 0;
      path.push({ node: name, edgeIndex: -1, hasMaxCycles: false });
      dfs(name);
      path.pop();
    }
  }

  return errors;
}

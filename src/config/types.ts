// ── Configuration Types ─────────────────────────────────────────────

export interface SwarmConfig {
  version: string;
  global: GlobalConfig;
  tools: Record<string, ToolConfig>;
  agents: Record<string, AgentDefinition>;
  topology: TopologyDefinition;
  synthesis: SynthesisConfig;
  /** Root directory of the config package (set at load time, not in YAML) */
  configPackageDir?: string;
}

export interface GlobalConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  charsPerToken: number;
  temperature: number;
  dbPath: string;
  resultsDir: string;
  vectorKvBaseUrl: string;
  limits: GlobalLimits;
  tokenBudget: TokenBudgetConfig;
}

export interface GlobalLimits {
  maxWorkers: number;
  workerTimeoutMs: number;
  wallClockTimeoutMs: number | null;
  toolBatchSize: number;
}

export interface TokenBudgetConfig {
  responseReserveFraction: number;
  responseReserveMax: number;
  compactionTrigger: number;
  compactionTarget: number;
}

export interface ToolConfig {
  enabled: boolean;
  plugin?: string;
  /** Path to external JS tool implementation (relative to config package root) */
  file?: string;
  /** Inline OpenAI function schema (alternative to defining in the JS file) */
  schema?: Record<string, unknown>;
  /** If true, calling this tool ends the agent loop */
  terminates?: boolean;
  /** Agent name — calling this tool spawns that agent (replaces hardcoded meta-tools) */
  spawns?: string;
  defaults: Record<string, unknown>;
}

export interface AgentDefinition {
  name: string;
  role: string;
  systemPrompt: string;
  model: string | null;
  temperature: number | null;
  execution: "in-process" | "worker";
  allowTextResponse: boolean;
  tools: string[];
  limits: AgentLimits;
  env: Record<string, string>;
  nudgeStrategy?: string;
}

export interface AgentLimits {
  maxIterations: number;
  toolCallBudget: number;
  tokenBudgetFraction: number;
  maxNudges: number;
}

export interface TopologyDefinition {
  entrypoint: string;
  edges: TopologyEdge[];
  terminal: { agent: string; tool: string };
}

export interface TopologyEdge {
  from: string;
  to: string;
  via: string;
  cardinality: "single" | "fan-out";
  maxConcurrent?: number | null;
  condition?: string;
  maxCycles?: number;
  strategy?: {
    type: string;
    [key: string]: unknown;
  };
  /** Inline schema for auto-generated bridge tools */
  toolSchema?: Record<string, unknown>;
}

export interface SynthesisConfig {
  default: string;
  strategies: Record<string, SynthesisStrategyConfig>;
}

export interface SynthesisStrategyConfig {
  [key: string]: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
}

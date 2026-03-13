# Specification: Configurable Agentic Swarm Framework

## 1. Configuration Schema

The configuration uses YAML for human readability. All fields have sensible defaults matching current behavior, so a minimal config reproducing today's system can be very short.

### 1.1 Top-Level Schema

```yaml
# swarm.yaml
version: "1"

# ── Global Settings ────────────────────────────────────────────────
global:
  model: "mistral-small-24b"          # default model for all agents
  baseUrl: "http://localhost:8000/v1"  # OpenAI-compatible endpoint
  apiKey: "not-needed"                 # API key (default: "not-needed")
  charsPerToken: 3                     # token estimation ratio
  temperature: 0.7                     # default sampling temperature
  dbPath: "data/knowledge.db"          # SQLite DB path
  resultsDir: "results"               # output directory
  vectorKvBaseUrl: "http://localhost:30080"  # vector-kv endpoint

  limits:
    maxWorkers: 5                      # concurrent child-process agents
    workerTimeoutMs: 300000            # 5 min per worker
    wallClockTimeoutMs: null           # total run timeout (null = unlimited)
    toolBatchSize: 5                   # max parallel tool calls per iteration

  tokenBudget:
    responseReserveFraction: 0.15      # reserved for model response
    responseReserveMax: 4096           # hard cap on response reserve
    compactionTrigger: 0.85            # compact when usage exceeds this fraction
    compactionTarget: 0.75             # compact down to this fraction

# ── Tool Definitions ──────────────────────────────────────────────
tools:
  web_search:
    enabled: true
    defaults:
      topResults: 8
      searxngUrl: "http://localhost:8080"

  fetch_page:
    enabled: true
    defaults:
      maxContentChars: 4000
      timeoutMs: 10000
      maxRetries: 3

  grep_code:
    enabled: true
    defaults:
      maxResults: 30
      maxResultsCap: 100
      timeoutMs: 15000

  search_code:
    enabled: true
    defaults:
      numResults: 5
      numResultsCap: 20
      timeoutMs: 30000

  query_knowledge:
    enabled: true
    defaults:
      topK: 5
      topKCap: 10

  # Custom tool via plugin
  # custom_tool:
  #   enabled: true
  #   plugin: "./plugins/my-tool.ts"   # must export a ToolHandler
  #   defaults: {}

# ── Agent Definitions ─────────────────────────────────────────────
agents:
  orchestrator:
    role: orchestrator
    systemPrompt: "prompts/orchestrator.md"   # file path (relative to config)
    model: null                                # null = inherit global
    temperature: null                          # null = inherit global
    execution: in-process                      # "in-process" | "worker"
    tools:
      - research_question                      # meta-tool: spawns researcher
      - synthesize_findings                    # meta-tool: triggers synthesis
      - critique                               # meta-tool: spawns critic
      - submit_final_report                    # terminates the swarm
    limits:
      maxIterations: 100
      toolCallBudget: 20
      tokenBudgetFraction: 0.45
      maxNudges: 3
    env: {}                                    # extra env vars

  researcher:
    role: researcher
    systemPrompt: "prompts/researcher.md"
    execution: worker                          # child process
    tools:
      - web_search
      - fetch_page
      - query_knowledge
      - grep_code
      - search_code                            # only active if vectorKey set
      - submit_finding                         # terminates this agent
    limits:
      maxIterations: 15
      toolCallBudget: 12
      tokenBudgetFraction: 0.30
    env: {}

  synthesizer:
    role: synthesizer
    systemPrompt: "prompts/synthesizer.md"
    execution: worker
    allowTextResponse: true                    # can finish with text, no tool
    tools: []                                  # no tools — pure text generation
    limits:
      maxIterations: 3
      tokenBudgetFraction: 0.40
    env: {}

  critic:
    role: critic
    systemPrompt: "prompts/critic.md"
    execution: worker
    tools:
      - submit_critique                        # terminates this agent
    limits:
      maxIterations: 3
      toolCallBudget: 12
      tokenBudgetFraction: 0.30
    env: {}

# ── Topology ──────────────────────────────────────────────────────
topology:
  entrypoint: orchestrator

  edges:
    - from: orchestrator
      to: researcher
      via: research_question                   # tool call that triggers spawn
      cardinality: fan-out                     # parallel, one per tool call
      maxConcurrent: null                      # null = limited by global.limits.maxWorkers

    - from: orchestrator
      to: synthesizer
      via: synthesize_findings
      cardinality: single                      # exactly one invocation
      # strategy overrides how synthesis works
      strategy:
        type: tournament                       # "tournament" | "single-pass" | "map-reduce" | "custom"
        maxDepth: 3                            # tournament bracket depth
        baseCaseSize: 3                        # items per leaf synthesis

    - from: orchestrator
      to: critic
      via: critique
      cardinality: single

    - from: critic
      to: orchestrator
      via: feedback                            # feedback loop edge
      condition: "result.approved === false"   # JS expression evaluated at runtime
      maxCycles: 2                             # max revision rounds

  # Terminal edge — calling this tool ends the swarm
  terminal:
    agent: orchestrator
    tool: submit_final_report

# ── Synthesis Strategy ────────────────────────────────────────────
synthesis:
  default: tournament
  strategies:
    tournament:
      maxDepth: 3
      baseCaseSize: 3
      synthesizerAgent: synthesizer            # which agent definition to use

    single-pass:
      synthesizerAgent: synthesizer

    map-reduce:
      mapAgent: synthesizer                    # runs per-finding
      reduceAgent: synthesizer                 # runs on mapped results
      chunkSize: 5

    # custom:
    #   plugin: "./plugins/my-synthesis.ts"
    #   options: {}
```

### 1.2 Schema Validation Rules (Caught at Config Load Time)

- Every agent referenced in `topology.edges` must exist in `agents`
- Every tool referenced in agent `tools` lists must exist in the `tools` section or be a known meta-tool (`research_question`, `synthesize_findings`, `critique`, `submit_final_report`, `submit_finding`, `submit_critique`)
- `topology.entrypoint` must reference a defined agent
- `topology.terminal.agent` must reference a defined agent
- `condition` expressions must parse as valid JS
- Cycle detection: edges must not form unbounded cycles (every cycle must have a `maxCycles` constraint)
- `systemPrompt` file paths must resolve to existing files
- Plugin paths must resolve to existing modules
- `tokenBudgetFraction` values across all agents should sum to <= 1.0 (warning, not error)
- `execution: "in-process"` agents cannot have `cardinality: fan-out` (they block the event loop)

---

## 2. Refactoring Plan

### 2.1 `src/llm.ts` — Model & Client Configuration

**Current state:** Global singleton `client` and `MODEL` constant initialized at module load from `process.env.BASE_URL` and `process.env.MODEL_NAME` (lines 10-16). `discoverModel()` caches a single `ModelInfo` in `_modelInfo` (line 26).

**Changes needed:**
- Extract `baseUrl`, `apiKey`, `model`, `charsPerToken` into `SwarmConfig.global`
- Replace module-level singletons with a factory function `createLLMClient(config: GlobalConfig): OpenAI` that returns a configured client
- `discoverModel()` should accept a client and model name, returning `ModelInfo` without caching in module state. Cache in `SwarmRunner` instead
- Per-agent model overrides mean multiple models may be in use. `discoverModel()` must support discovering multiple models and caching per model ID
- The `MODEL` export disappears; agents receive their model ID from their `AgentDefinition`

**Stays as-is:** The OpenAI SDK client interface, the model discovery strategy (querying `/v1/models`).

### 2.2 `src/agent-loop.ts` — Generic ReAct Loop

**Current state:** `agentLoop()` accepts `AgentLoopOptions` (line 40). Hardcoded values:
- `toolCallBudget`: orchestrator=20, others=12 (line 137)
- `TOOL_BATCH_SIZE = 5` (line 271)
- `temperature: 0.7` (line 177)
- Role detection by string matching on `name` (lines 97-100)
- Nudge count threshold: 3 (line 220)
- Retry: 3 attempts, exponential backoff base 1s (lines 171-191)
- The orchestrator-specific nudge logic with `hasSynthesis`/`hasCritique`/`hasReport` checks (lines 226-236)

**Changes needed:**
- Add to `AgentLoopOptions`: `toolCallBudget`, `toolBatchSize`, `temperature`, `model`, `maxNudges`, `retryConfig: { maxAttempts, baseDelayMs }`
- Remove the hardcoded role detection block (lines 97-100). The caller passes `tokenBudgetFraction` and `toolCallBudget` directly — no need for `agentLoop` to infer role from the agent name
- Remove orchestrator-specific nudge logic from `agentLoop`. Instead, add a `nudgeStrategy?: (ctx, agentName) => string | null` callback in `AgentLoopOptions`. The orchestrator's nudge strategy moves to `src/tools/research.ts` or a new `src/nudges/orchestrator.ts`
- `temperature` and `model` are passed through to the `client.chat.completions.create()` call instead of using module globals
- Accept an `llmClient: OpenAI` in `AgentLoopOptions` instead of importing the global `client`

**Stays as-is:** The core iteration loop structure, compaction integration, tool result handling, the terminating-tool deferred-review logic, `_nodeId` extraction from results.

### 2.3 `src/worker-pool.ts` — Worker Process Management

**Current state:** `MAX_WORKERS` from env (line 140, default 5). `WORKER_TIMEOUT_MS = 300000` (line 144). `WorkerInput` interface includes hardcoded `env` shape (lines 25-31). Workers spawned via `npx tsx worker.ts` (line 195).

**Changes needed:**
- `MAX_WORKERS` and `WORKER_TIMEOUT_MS` read from `SwarmConfig.global.limits`
- `Semaphore` initialized from config, not module-level constant
- `WorkerInput.env` extended to accept arbitrary env vars from `AgentDefinition.env`, merged with global env
- `spawnAgent()` accepts the full `AgentDefinition` instead of raw `WorkerInput` — the `AgentFactory` builds `WorkerInput` from the definition
- The `buildWorkerEnv()` helper (line 295) moves into `AgentFactory` where it merges global config env with per-agent env

**New abstraction:** `WorkerPoolConfig` type extracted from `SwarmConfig.global.limits`.

**Stays as-is:** The `Semaphore` class, the child-process spawning mechanism, the JSON-line protocol (stdin/stdout), the pool stats accumulator.

### 2.4 `src/worker.ts` — Worker Entry Point

**Current state:** Tool resolution via a hardcoded `switch` statement in `resolveTools()` (lines 54-149). Inline tool definitions for `submit_finding` (lines 75-103) and `submit_critique` (lines 105-143).

**Changes needed:**
- Replace the `switch` statement with a `ToolRegistry.resolve(toolConfigs)` call. The registry maps tool type names to `ToolHandler` factories
- Extract inline `submit_finding` and `submit_critique` definitions into `src/tools/submitFinding.ts` and `src/tools/submitCritique.ts` respectively, so they can be registered like all other tools
- `resolveTools` accepts a `ToolRegistry` instance, looks up each tool config, and returns `ToolHandler[]`
- The worker receives the `ToolRegistry` configuration as part of `WorkerInput` (tool type names + per-tool overrides)

**Stays as-is:** The stdin JSON protocol, the SQLite DB connection (shared WAL), the log/result messaging.

### 2.5 `src/tools/*.ts` — Individual Tool Handlers

**Current state per tool:**

| Tool | Hardcoded Limits | File |
|------|-----------------|------|
| `web_search` | `topResults = 8`, SEARXNG_URL from env | `webSearch.ts:62,5` |
| `fetch_page` | `4000 char` truncation, `10s` timeout, `3` retries | `fetchPage.ts:94,63,58` |
| `grep_code` | `maxResults default=30, cap=100`, `15s` timeout | `grepCode.ts:37,68` |
| `search_code` | `k default=5, cap=20`, `30s` timeout | `searchCode.ts:38,44` |
| `query_knowledge` | `topK default=5, cap=10` | `queryKnowledge.ts:44` |

**Changes needed for each:**
- Convert each tool from a singleton `ToolHandler` export to a factory function `createXxxTool(config: XxxToolConfig): ToolHandler` that accepts per-tool defaults from the config schema
- Factory functions read defaults from `SwarmConfig.tools.xxx.defaults` and use them as fallback values when the LLM doesn't specify a parameter
- `webSearchTool` → `createWebSearchTool({ topResults, searxngUrl })`
- `fetchPageTool` → `createFetchPageTool({ maxContentChars, timeoutMs, maxRetries })`
- `grepCodeTool` → `createGrepCodeTool({ maxResults, maxResultsCap, timeoutMs })`
- `createSearchCodeTool(vectorKey)` → `createSearchCodeTool({ vectorKey, numResults, numResultsCap, timeoutMs })`
- `createQueryKnowledgeTool()` → `createQueryKnowledgeTool({ topK, topKCap })`

**Stays as-is:** The core logic of each handler (HTML stripping, grep invocation, vector-kv CLI call, knowledge store indexing).

### 2.6 `src/tools/research.ts` — Research Question Meta-Tool

**Current state:** Hardcodes researcher prompt path (line 10), `maxIterations: 15` (line 66), the tool list for workers (lines 51-58), and calls `spawnAgent()` directly.

**Changes needed:**
- Becomes a factory: `createResearchQuestionTool(config: SwarmConfig, topology: TopologyDefinition): ToolHandler`
- Reads the researcher `AgentDefinition` from config instead of hardcoding prompt path, iterations, tool list
- Uses `AgentFactory.createWorker(agentDef)` instead of calling `spawnAgent()` directly
- The tool list for the researcher worker comes from `agents.researcher.tools` in config

### 2.7 `src/tools/synthesize.ts` — Synthesize Findings Meta-Tool

**Current state:** Calls `tournamentSynthesize()` directly (line 43).

**Changes needed:**
- Becomes a factory that accepts a `SynthesisStrategyConfig` from the config
- Uses a strategy resolver to pick `tournamentSynthesize`, `singlePassSynthesize`, `mapReduceSynthesize`, or a custom plugin
- Strategy parameters (bracket size, max depth) come from config

### 2.8 `src/tools/critique.ts` — Critique Meta-Tool

**Current state:** Hardcodes critic prompt path (line 9), `maxIterations: 3` (line 49), tool list `[{ type: "submit_critique" }]` (line 51).

**Changes needed:**
- Same pattern as research.ts — factory function reads from `agents.critic` definition in config

### 2.9 `src/token-budget.ts` — Token Budget Management

**Current state:** Role-based fractions hardcoded (lines 60-65). Response reserve formula hardcoded (line 54). Compaction thresholds hardcoded (lines 75, 122).

**Changes needed:**
- `deriveBudget()` accepts explicit `tokenBudgetFraction` from the agent definition instead of looking up by role string
- Compaction trigger and target fractions come from `SwarmConfig.global.tokenBudget`
- Response reserve fraction/max come from config
- The function signature changes from `deriveBudget(role, toolOverhead)` to `deriveBudget(fraction, toolOverhead, budgetConfig)`

**Stays as-is:** The estimation functions (`estimateMessageTokens`, `estimateToolOverhead`), compaction mechanics.

### 2.10 `src/tournament.ts` — Tournament Synthesis

**Current state:** Hardcoded `maxIterations: 3` for synthesizer workers (lines 55, 108), base case at `<= 3` findings or `depth >= 3` (line 94).

**Changes needed:**
- `tournamentSynthesize()` accepts a `TournamentConfig: { maxDepth, baseCaseSize, synthesizerAgent: AgentDefinition }` parameter
- Uses `AgentFactory` to spawn synthesizer workers with the agent definition from config
- `baseCaseSize` and `maxDepth` come from `synthesis.strategies.tournament` in config

### 2.11 `src/context.ts` — Context Database

**Current state:** Well-abstracted. `MAX_EVENT_OUTPUT_CHARS = 1000` (line 61) is the only hardcoded constant.

**Changes needed:**
- `MAX_EVENT_OUTPUT_CHARS` becomes configurable (minor — could stay hardcoded with an optional override)
- No major structural changes needed — `ContextDB` and `Context` are already clean abstractions

**Stays as-is:** All DB operations, table schema, serialization helpers, `addNode`, `addEvent`, `setStore`.

### 2.12 `src/orchestrator.ts` — Entry Point

**Current state:** This is the main `runResearch()` function. It hardcodes the tool list (lines 92-97), `maxIterations: 100` (line 115), DB path (line 18), and prompt path (lines 21-24).

**Changes needed:**
- `runResearch()` is replaced by `SwarmRunner.run(goal, config)`. The function:
  1. Loads and validates the YAML config
  2. Creates the LLM client(s)
  3. Discovers model(s)
  4. Opens the SQLite DB (path from config)
  5. Creates the `ToolRegistry` and registers all configured tools
  6. Creates the `AgentFactory` with the tool registry and config
  7. Resolves the topology to determine the entrypoint agent
  8. Runs the entrypoint agent's loop
  9. Handles the summary/reporting
- The partial report builder (`buildPartialReport`, lines 26-61) moves to a separate utility

### 2.13 `src/index.ts` — CLI Entry Point

**Current state:** Parses `--vector-key` argument (lines 30-50), calls `runResearch()`.

**Changes needed:**
- Add `--config <path>` argument (default: `swarm.yaml`)
- The `--vector-key` becomes a runtime variable passed into the config's template context (for system prompt interpolation)
- Calls `SwarmRunner.run()` instead of `runResearch()`

### 2.14 `src/prompts/*.md` — System Prompts

**Current state:** Static markdown files read at startup via `fs.readFileSync`.

**Changes needed:**
- Add Mustache/Handlebars-style variable interpolation. Currently the only runtime injection is the `promptAddendum` for vector key in `orchestrator.ts` (line 102)
- Template variables: `{{goal}}`, `{{vectorKey}}`, `{{agentName}}`, and any custom vars from `AgentDefinition.env`
- Prompts remain as markdown files on disk — the config just points to them via `systemPrompt` path
- Support inline prompts in config via `systemPrompt: "inline: You are a..."` as an alternative to file paths

---

## 3. New Abstractions

### 3.1 `SwarmConfig`

```typescript
interface SwarmConfig {
  version: string;
  global: GlobalConfig;
  tools: Record<string, ToolConfig>;
  agents: Record<string, AgentDefinition>;
  topology: TopologyDefinition;
  synthesis: SynthesisConfig;
}

interface GlobalConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  charsPerToken: number;
  temperature: number;
  dbPath: string;
  resultsDir: string;
  vectorKvBaseUrl: string;
  limits: {
    maxWorkers: number;
    workerTimeoutMs: number;
    wallClockTimeoutMs: number | null;
    toolBatchSize: number;
  };
  tokenBudget: {
    responseReserveFraction: number;
    responseReserveMax: number;
    compactionTrigger: number;
    compactionTarget: number;
  };
}

interface ToolConfig {
  enabled: boolean;
  plugin?: string;           // path to custom ToolHandler module
  defaults: Record<string, unknown>;
}
```

### 3.2 `AgentDefinition`

```typescript
interface AgentDefinition {
  name: string;              // key from config
  role: string;              // for logging/identity
  systemPrompt: string;      // file path or "inline: ..." string
  model: string | null;      // null = inherit global
  temperature: number | null;
  execution: "in-process" | "worker";
  allowTextResponse: boolean;
  tools: string[];           // tool names this agent can use
  limits: {
    maxIterations: number;
    toolCallBudget: number;
    tokenBudgetFraction: number;
    maxNudges: number;
  };
  env: Record<string, string>;
  nudgeStrategy?: string;    // path to custom nudge module, or "default"
}
```

### 3.3 `TopologyDefinition`

```typescript
interface TopologyDefinition {
  entrypoint: string;                    // agent name
  edges: TopologyEdge[];
  terminal: { agent: string; tool: string };
}

interface TopologyEdge {
  from: string;                          // source agent name
  to: string;                            // target agent name
  via: string;                           // tool call that triggers this edge
  cardinality: "single" | "fan-out";
  maxConcurrent?: number | null;
  condition?: string;                    // JS expression for conditional edges
  maxCycles?: number;                    // for feedback loops
  strategy?: {                           // for synthesis edges
    type: string;
    [key: string]: unknown;
  };
}
```

### 3.4 `ToolRegistry`

```typescript
class ToolRegistry {
  private factories: Map<string, ToolHandlerFactory>;

  /** Register a tool factory by name */
  register(name: string, factory: ToolHandlerFactory): void;

  /** Register all built-in tools */
  registerBuiltins(config: SwarmConfig): void;

  /** Load and register a custom tool plugin */
  registerPlugin(name: string, pluginPath: string, defaults: Record<string, unknown>): Promise<void>;

  /** Resolve a list of tool names to ToolHandler instances */
  resolve(toolNames: string[], runtimeContext: ToolRuntimeContext): ToolHandler[];

  /** Get the definition (schema) for a named tool */
  getDefinition(name: string): ChatCompletionTool | null;
}

type ToolHandlerFactory = (config: ToolConfig, runtimeContext: ToolRuntimeContext) => ToolHandler;

interface ToolRuntimeContext {
  ctx: Context;
  vectorKey?: string;
  agentFactory?: AgentFactory;  // for meta-tools that spawn agents
}
```

Built-in tool registration:

```typescript
registry.register("web_search", (config) => createWebSearchTool(config.defaults));
registry.register("fetch_page", (config) => createFetchPageTool(config.defaults));
registry.register("grep_code", (config) => createGrepCodeTool(config.defaults));
registry.register("search_code", (config, rt) =>
  createSearchCodeTool({ ...config.defaults, vectorKey: rt.vectorKey }));
registry.register("query_knowledge", (config) => createQueryKnowledgeTool(config.defaults));
registry.register("submit_finding", () => createSubmitFindingTool());
registry.register("submit_critique", () => createSubmitCritiqueTool());

// Meta-tools — need topology awareness
registry.register("research_question", (config, rt) =>
  createResearchQuestionTool(rt.agentFactory!, "researcher"));
registry.register("synthesize_findings", (config, rt) =>
  createSynthesizeTool(rt));
registry.register("critique", (config, rt) =>
  createCritiqueTool(rt.agentFactory!, "critic"));
registry.register("submit_final_report", () => submitReportTool);
```

### 3.5 `AgentFactory`

```typescript
class AgentFactory {
  constructor(
    private config: SwarmConfig,
    private toolRegistry: ToolRegistry,
    private llmClients: Map<string, OpenAI>,  // model -> client
    private modelInfoCache: Map<string, ModelInfo>,
  ) {}

  /** Create an in-process agent and run its loop */
  async runInProcess(
    agentName: string, userMessage: string, ctx: Context
  ): Promise<AgentLoopResult>;

  /** Spawn a worker-process agent */
  async spawnWorker(
    agentName: string, userMessage: string, ctx: Context
  ): Promise<WorkerResultMessage>;

  /** Resolve which method to use based on AgentDefinition.execution */
  async run(
    agentName: string, userMessage: string, ctx: Context
  ): Promise<AgentLoopResult>;

  /** Build the WorkerInput for a child-process agent */
  private buildWorkerInput(
    def: AgentDefinition, userMessage: string, sessionId: string
  ): WorkerInput;

  /** Render a system prompt template with runtime variables */
  private renderPrompt(
    def: AgentDefinition, vars: Record<string, string>
  ): string;
}
```

### 3.6 `SwarmRunner`

```typescript
class SwarmRunner {
  private config: SwarmConfig;
  private toolRegistry: ToolRegistry;
  private agentFactory: AgentFactory;

  /** Load config from YAML file, validate, and prepare the runner */
  static async fromFile(configPath: string): Promise<SwarmRunner>;

  /** Load config from an object (for programmatic use) */
  static async fromConfig(config: SwarmConfig): Promise<SwarmRunner>;

  /** Validate the configuration (schema + topology + file existence) */
  private validate(): ValidationResult;

  /** Run the swarm with the given goal */
  async run(goal: string, runtimeVars?: Record<string, string>): Promise<RunResult>;

  /** Build the topology graph and detect cycles/errors */
  private buildTopologyGraph(): TopologyGraph;
}

interface RunResult {
  ctx: Context;
  reportPath: string | null;
  stats: {
    duration: number;
    poolStats: PoolStats;
    orchestratorStats: AgentStats;
  };
}
```

### 3.7 `SynthesisStrategy` (Interface for Pluggable Synthesis)

```typescript
interface SynthesisStrategy {
  synthesize(
    goal: string,
    findings: Finding[],
    ctx: Context,
    agentFactory: AgentFactory,
  ): Promise<string>;
}

class TournamentSynthesis implements SynthesisStrategy {
  constructor(private config: {
    maxDepth: number; baseCaseSize: number; synthesizerAgent: string;
  }) {}
  async synthesize(goal, findings, ctx, agentFactory): Promise<string>;
}

class SinglePassSynthesis implements SynthesisStrategy {
  constructor(private config: { synthesizerAgent: string }) {}
  async synthesize(goal, findings, ctx, agentFactory): Promise<string>;
}

class MapReduceSynthesis implements SynthesisStrategy {
  constructor(private config: {
    mapAgent: string; reduceAgent: string; chunkSize: number;
  }) {}
  async synthesize(goal, findings, ctx, agentFactory): Promise<string>;
}
```

---

## 4. Example Configurations

### Example A: Current Behavior (Backwards Compatibility)

```yaml
version: "1"

global:
  model: "mistral-small-24b"
  baseUrl: "http://localhost:8000/v1"
  charsPerToken: 3
  temperature: 0.7
  limits:
    maxWorkers: 5
    workerTimeoutMs: 300000

agents:
  orchestrator:
    role: orchestrator
    systemPrompt: "prompts/orchestrator.md"
    execution: in-process
    tools: [research_question, synthesize_findings, critique, submit_final_report]
    limits:
      maxIterations: 100
      toolCallBudget: 20
      tokenBudgetFraction: 0.45

  researcher:
    role: researcher
    systemPrompt: "prompts/researcher.md"
    execution: worker
    tools: [web_search, fetch_page, query_knowledge, grep_code, search_code, submit_finding]
    limits:
      maxIterations: 15
      toolCallBudget: 12
      tokenBudgetFraction: 0.30

  synthesizer:
    role: synthesizer
    systemPrompt: "prompts/synthesizer.md"
    execution: worker
    allowTextResponse: true
    tools: []
    limits:
      maxIterations: 3
      tokenBudgetFraction: 0.40

  critic:
    role: critic
    systemPrompt: "prompts/critic.md"
    execution: worker
    tools: [submit_critique]
    limits:
      maxIterations: 3
      tokenBudgetFraction: 0.30

topology:
  entrypoint: orchestrator
  edges:
    - { from: orchestrator, to: researcher, via: research_question, cardinality: fan-out }
    - { from: orchestrator, to: synthesizer, via: synthesize_findings, cardinality: single }
    - { from: orchestrator, to: critic, via: critique, cardinality: single }
    - { from: critic, to: orchestrator, via: feedback,
        condition: "result.approved === false", maxCycles: 2 }
  terminal: { agent: orchestrator, tool: submit_final_report }

synthesis:
  default: tournament
  strategies:
    tournament: { maxDepth: 3, baseCaseSize: 3, synthesizerAgent: synthesizer }
```

### Example B: Deep-Dive Pipeline

```yaml
version: "1"

global:
  model: "qwen3-32b"
  baseUrl: "http://localhost:8000/v1"
  temperature: 0.6
  limits:
    maxWorkers: 8
    workerTimeoutMs: 600000

tools:
  web_search:
    defaults: { topResults: 12 }
  fetch_page:
    defaults: { maxContentChars: 8000 }

agents:
  planner:
    role: orchestrator
    systemPrompt: "prompts/planner.md"
    execution: in-process
    tools: [plan_research]       # spawns researchers
    limits:
      maxIterations: 10
      toolCallBudget: 8
      tokenBudgetFraction: 0.20

  researcher:
    role: researcher
    systemPrompt: "prompts/researcher.md"
    execution: worker
    tools: [web_search, fetch_page, grep_code, search_code, submit_finding]
    limits:
      maxIterations: 20
      toolCallBudget: 16
      tokenBudgetFraction: 0.35

  fact_checker:
    role: critic
    systemPrompt: "prompts/fact-checker.md"
    execution: worker
    tools: [web_search, fetch_page, submit_verification]
    limits:
      maxIterations: 10
      toolCallBudget: 8
      tokenBudgetFraction: 0.25

  synthesizer:
    role: synthesizer
    systemPrompt: "prompts/synthesizer.md"
    execution: worker
    allowTextResponse: true
    tools: []
    limits:
      maxIterations: 5
      tokenBudgetFraction: 0.40

  editor:
    role: synthesizer
    systemPrompt: "prompts/editor.md"
    execution: worker
    allowTextResponse: true
    tools: []
    limits:
      maxIterations: 3
      tokenBudgetFraction: 0.35

topology:
  entrypoint: planner
  edges:
    - { from: planner, to: researcher, via: plan_research, cardinality: fan-out }
    - { from: researcher, to: fact_checker, via: pass_findings, cardinality: single }
    - { from: fact_checker, to: synthesizer, via: pass_verified, cardinality: single }
    - { from: synthesizer, to: editor, via: pass_draft, cardinality: single }
  terminal: { agent: editor, tool: submit_final_report }

synthesis:
  default: single-pass
  strategies:
    single-pass: { synthesizerAgent: synthesizer }
```

### Example C: Debate Topology

```yaml
version: "1"

global:
  model: "mistral-small-24b"
  baseUrl: "http://localhost:8000/v1"
  temperature: 0.8                     # higher temp for diverse arguments
  limits:
    maxWorkers: 4

agents:
  moderator:
    role: orchestrator
    systemPrompt: "prompts/moderator.md"
    execution: in-process
    tools: [start_debate, request_judgment, submit_final_report]
    limits:
      maxIterations: 30
      toolCallBudget: 15
      tokenBudgetFraction: 0.30

  advocate:
    role: researcher
    systemPrompt: "prompts/argue-for.md"    # "Build the strongest case FOR..."
    execution: worker
    tools: [web_search, fetch_page, submit_finding]
    limits:
      maxIterations: 15
      toolCallBudget: 12
      tokenBudgetFraction: 0.30

  adversary:
    role: researcher
    systemPrompt: "prompts/argue-against.md"  # "Build the strongest case AGAINST..."
    execution: worker
    tools: [web_search, fetch_page, submit_finding]
    limits:
      maxIterations: 15
      toolCallBudget: 12
      tokenBudgetFraction: 0.30

  judge:
    role: synthesizer
    systemPrompt: "prompts/judge.md"         # "Evaluate both arguments impartially..."
    execution: worker
    allowTextResponse: true
    tools: [submit_verdict]                   # terminates with {balanced: bool, verdict: string}
    limits:
      maxIterations: 5
      tokenBudgetFraction: 0.40

topology:
  entrypoint: moderator
  edges:
    # Moderator spawns both debaters in parallel
    - { from: moderator, to: advocate, via: start_debate, cardinality: fan-out }
    - { from: moderator, to: adversary, via: start_debate, cardinality: fan-out }

    # Judge evaluates both arguments
    - { from: moderator, to: judge, via: request_judgment, cardinality: single }

    # Judge can send back for another round
    - from: judge
      to: moderator
      via: feedback
      condition: "result.balanced === false"
      maxCycles: 3

  terminal: { agent: moderator, tool: submit_final_report }

synthesis:
  default: single-pass
  strategies:
    single-pass: { synthesizerAgent: judge }
```

---

## 5. Risks and Trade-offs

### 5.1 Flexibility vs. Complexity

**Where to draw the line:**
- **Include:** Agent definitions, topology edges, per-agent limits, tool defaults, synthesis strategy selection. These are the high-value configuration surfaces — they change between use cases.
- **Exclude from config:** Internal retry backoff formulas, compaction algorithms, HTML stripping logic, DB schema, the JSON-line worker protocol. These are implementation details that rarely need user customization.
- **Risk:** The `condition` field (JS expression evaluation) is powerful but introduces a scripting language into config. If misused, configs become opaque. Mitigation: limit to simple property access expressions (`result.approved === false`, `result.score > 0.8`) and validate at load time. Do not expose `eval()` — use a safe expression parser like `expr-eval` or `filtrex`.

### 5.2 Fully Dynamic Topology at Runtime

**What breaks:**
- **Cycle detection becomes intractable.** Static config allows us to detect unbounded cycles at load time. If agents can dynamically spawn arbitrary other agents via tool calls, a misconfigured prompt could cause infinite loops.
- **Resource exhaustion.** Without static topology, there's no way to predict or cap the total number of agents spawned.
- **Debugging opacity.** When topology is emergent from LLM decisions rather than declared, it's much harder to understand why a swarm behaved a certain way.

**Recommendation:** Keep topology static in config. The `maxCycles` constraint on feedback edges and `maxIterations` per agent are the safety rails. If a user truly needs dynamic topology (agent A decides at runtime whether to spawn B or C), support it via conditional edges with expressions, not arbitrary agent-to-agent calls.

### 5.3 Performance Implications

- **Config parsing overhead:** Negligible — YAML parsing happens once at startup.
- **Factory indirection:** Each tool and agent is created via factory functions rather than direct imports. The extra function call per tool creation adds nanoseconds — irrelevant compared to LLM API latency (seconds).
- **Per-agent model clients:** If agents use different models, multiple OpenAI clients and model discovery calls are needed. This adds startup latency proportional to the number of distinct models. Mitigation: discover models in parallel.
- **Worker serialization:** `WorkerInput` grows slightly to carry per-tool config overrides. The JSON overhead is trivial.

### 5.4 Error Handling in User-Defined Topologies

**Caught at config-load time (validation):**
- Missing agent references in edges
- Missing tool references in agent tool lists
- Unbounded cycles (cycles without `maxCycles`)
- Invalid condition expressions (parse check)
- Missing prompt files
- Missing plugin modules
- `fan-out` cardinality on `in-process` agents (would block the event loop)
- Sum of `tokenBudgetFraction` exceeding 1.0 (warning)

**Caught at runtime:**
- Agent fails to produce a result within `maxIterations` (existing partial-report fallback)
- Worker timeout (existing `WORKER_TIMEOUT_MS` kill mechanism)
- Condition expression evaluates to a runtime error (catch, log, treat as `false`)
- Custom plugin throws during initialization (catch, log, abort with clear error message pointing to the plugin path)
- Tool referenced in config is not available (e.g., `search_code` without `vectorKey`) — skip with warning at startup, fail at call time with clear error

**Recommended validation API:**

```typescript
const runner = await SwarmRunner.fromFile("swarm.yaml");
const validation = runner.validate();
if (!validation.ok) {
  for (const error of validation.errors) {
    console.error(`[${error.path}] ${error.message}`);
    // e.g. "[topology.edges[2].to] Agent 'reviewer' is not defined in agents"
  }
  process.exit(1);
}
```

### 5.5 Migration Path

The refactoring can proceed incrementally without breaking existing functionality:

1. **Phase 1 — Config loading.** Add `SwarmConfig` type and YAML loader. Generate a default config that reproduces current behavior. `runResearch()` internally constructs this default config. No behavior change.

2. **Phase 2 — Tool factories.** Convert each tool from singleton to factory. The factory reads from config but falls back to current hardcoded defaults. `worker.ts` switch statement still works, just calls factories.

3. **Phase 3 — ToolRegistry.** Introduce the registry. Replace the `worker.ts` switch with `registry.resolve()`. Register all built-in tools. The orchestrator's meta-tools (research, synthesize, critique) become registry entries.

4. **Phase 4 — AgentFactory.** Extract agent creation from `research.ts`, `critique.ts`, and `tournament.ts` into `AgentFactory`. These tools call `agentFactory.run()` instead of `spawnAgent()` directly.

5. **Phase 5 — TopologyDefinition.** Introduce topology-aware orchestration. The entrypoint agent's tools are wired according to topology edges. Conditional feedback loops use the edge definitions. The hardcoded orchestrator nudge logic is extracted into a configurable strategy.

6. **Phase 6 — SwarmRunner.** Replace `runResearch()` with `SwarmRunner.run()`. Add `--config` CLI argument. The old `runResearch(goal, vectorKey)` becomes a thin wrapper that constructs a default config and calls `SwarmRunner`.

Each phase is independently testable by running the existing research workflow and verifying identical output.

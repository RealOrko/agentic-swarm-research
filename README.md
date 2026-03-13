# 🐝 Agentic Swarm Research

A multi-agent research system that takes a question, breaks it into sub-questions, researches each one via web search and/or semantic code search, synthesizes the findings, and produces a critique-reviewed markdown report.

The entire system — agents, tools, topology, synthesis strategy — is defined in **config packages**: self-contained directories of YAML + JS + markdown. The TypeScript runtime is a domain-agnostic execution engine with zero research-specific knowledge baked in.

## 🏗️ Architecture

The system uses a tool-call-driven orchestration pattern. The **orchestrator** is a persistent agent loop whose available tools are auto-generated from topology edges. Other agents (researcher, synthesizer, critic) are invoked as bridge tools, each running their own agent loop in worker processes.

```
🎯 User question
  └─ 🧠 Orchestrator
       ├─ 🔍 research_question(q1) ──► Researcher ──► web_search / fetch_page ──► submit_finding
       ├─ 🔍 research_question(q2) ──► Researcher ──► grep_code / search_code ──► submit_finding
       │        (parallel fan-out, mixed web + code research)
       ├─ 📝 synthesize_findings ──► Tournament or Single-pass synthesis
       │        tournament: pairwise merge across worker pool
       │        single-pass: one synthesizer processes all findings
       ├─ 🔎 critique ────────────► Critic ────────► submit_critique
       │        (loop if gaps found, configurable max cycles)
       └─ 📄 submit_final_report ─► results/<date>-<slug>/report.md
```

### 🤖 Agents

| Agent | Role | Execution | Tools |
|-------|------|-----------|-------|
| 🧠 **Orchestrator** | Decomposes goal, dispatches work, manages flow | in-process | `research_question`, `synthesize_findings`, `critique`, `submit_final_report` |
| 🔍 **Researcher** | Investigates a sub-question via web/code search | worker | `web_search`, `fetch_page`, `grep_code`, `search_code`, `query_knowledge`, `submit_finding` |
| 📝 **Synthesizer** | Combines findings into a coherent narrative | worker | _(none — text response)_ |
| 🔎 **Critic** | Reviews synthesis for gaps and quality | worker | `submit_critique` |

### 💡 Key Design Decisions

- 🔧 **Tool calls as structured output** — all agent-to-agent communication happens via tool call arguments, avoiding free-text parsing
- 🌉 **Auto-generated bridge tools** — topology edges like `{ from: A, to: B, via: tool_name }` automatically generate tools that spawn agent B and return its result. No hand-coded meta-tool wiring.
- 📦 **Config packages** — a `configs/<swarm>/` directory is a self-contained portable swarm definition: `swarm.yaml` + `tools/*.js` + `prompts/*.md` + `strategies/*.js` + `nudges/*.js`
- 📋 **YAML-configurable topology** — agent wiring, tool defaults, synthesis strategy, and iteration limits are all defined in config files that deep-merge with defaults
- ⚙️ **Worker pool** — researcher, synthesizer, and critic agents run as child processes with configurable concurrency (`maxWorkers`) and timeouts
- 🏆 **Tournament synthesis** — large finding sets are merged pairwise across multiple rounds before a final synthesis pass
- 📊 **Token budget management** — each agent gets a fraction of the model's context window; messages are compacted when the budget is exceeded
- 🗄️ **Shared SQLite context** — a structured store + append-only event log that traces every tool call and result
- 🔗 **Semantic code search via [vector-kv](https://github.com/RealOrko/vector-kv)** — codebases are indexed into vector-kv and queried semantically at search time

## 📦 Prerequisites

- 🟢 Node.js >= 18
- 🐳 Docker (for SearXNG search engine)
- 🤖 An OpenAI-compatible LLM endpoint (local or remote)
- 🔗 [vector-kv](https://github.com/RealOrko/vector-kv) — for semantic code search (optional)

## 🚀 Setup

1. Install dependencies and link the CLI:

```bash
npm install
npm link
```

This makes the `agentic-research` command available globally.

2. Create a `.env` file:

```
BASE_URL=http://localhost:8000/v1
MODEL_NAME=qwen3-coder-next
SEARXNG_URL=http://localhost:8080
```

3. Start SearXNG (self-hosted search engine):

```bash
npm run setup
```

This pulls and runs a SearXNG Docker container with JSON API enabled. The container restarts automatically unless stopped.

## 🎮 Usage

```
agentic-research [options] "<research question>"

OPTIONS
  --config <path>       Path to swarm YAML config or config package directory
  --codebase <path>     Path to a codebase directory. Automatically indexes it
                        into vector-kv and enables semantic code search tools.
  --glob <pattern>      Glob filter for --codebase indexing (e.g. "*.ts")
  --vector-key <key>    Use an existing vector-kv key (cannot combine with --codebase)
  --help, -h            Show this help message

ENVIRONMENT
  BASE_URL      LLM endpoint (default: http://localhost:8000/v1)
  MODEL_NAME    Model to use (default: qwen3-coder-next)
  SEARXNG_URL   SearXNG instance for web search
  MAX_WORKERS   Max parallel worker agents (default: 5)
```

### 📚 Examples

```bash
# 🌐 Pure web research (built-in defaults)
agentic-research "What are the leading approaches to quantum computing?"

# ⚡ Quick overview with fewer workers and no critic
agentic-research --config configs/quick.yaml "What is WebAssembly?"

# 🔬 Deep investigation with tournament synthesis
agentic-research --config configs/deep.yaml "Compare modern JavaScript bundlers"

# 📦 Run a config package (directory with swarm.yaml + tools/ + prompts/)
agentic-research --config configs/default-research "What is CRISPR gene editing?"

# 💻 Auto-index and research a codebase
agentic-research --codebase ./my-project "How does the parser handle errors?"

# 📂 Index only TypeScript files
agentic-research --codebase ./my-project --glob "*.ts" "Analyze the error handling"

# 🔑 Use a previously indexed codebase
agentic-research --vector-key my-project "How does the parser handle errors?"
```

### 📁 Output

Results are written to `./results/<date>-<slug>/`:

- 📄 **`report.md`** — the final research report in markdown
- 🔍 **`context.json`** — full execution trace (store state + event log)

## ⚙️ Configuration

The system ships with built-in defaults that work out of the box. There are two ways to customize:

### 1. YAML override files

Create a YAML file that overrides specific settings. Everything else inherits from defaults via deep merge.

```yaml
version: "1"

global:
  temperature: 0.7
  limits:
    maxWorkers: 5
    toolBatchSize: 5

tools:
  web_search:
    defaults:
      topResults: 8
  fetch_page:
    defaults:
      maxContentChars: 4000

agents:
  orchestrator:
    tools: [research_question, synthesize_findings, critique, submit_final_report]
    limits:
      maxIterations: 100
      toolCallBudget: 20

topology:
  edges:
    - { from: orchestrator, to: researcher, via: research_question, cardinality: fan-out }
    - { from: orchestrator, to: synthesizer, via: synthesize_findings, cardinality: single,
        strategy: { type: tournament } }
    - { from: orchestrator, to: critic, via: critique, cardinality: single }
    - { from: critic, to: orchestrator, via: feedback,
        condition: "result.approved === false", maxCycles: 2 }
  terminal: { agent: orchestrator, tool: submit_final_report }

synthesis:
  default: tournament
  strategies:
    tournament: { maxDepth: 3, baseCaseSize: 3, synthesizerAgent: synthesizer }
    single-pass: { synthesizerAgent: synthesizer }
```

### 2. Config packages

A config package is a self-contained directory with external JS tool implementations, prompts, and strategies:

```
configs/my-swarm/
├── swarm.yaml              # Main config
├── tools/                  # Tool implementations (JS modules)
│   ├── web_search.js       # exports { schema, handler }
│   └── ...
├── prompts/                # System prompts (markdown)
│   ├── orchestrator.md
│   └── ...
├── strategies/             # Custom synthesis strategies (optional)
│   └── tournament.js       # exports { synthesize }
└── nudges/                 # Custom nudge strategies (optional)
    └── orchestrator.js     # exports { nudge }
```

Tool JS files export a `schema` (OpenAI function-calling format) and an async `handler(args, ctx)`. The runtime injects a context with `fetch`, `exec`, `knowledgeStore`, `spawnAgent`, `config`, and `log`.

Pass a config package directory to `--config`:

```bash
agentic-research --config configs/default-research "Your question here"
```

### 🎛️ Preset configs

| Config | Use case | Key differences |
|--------|----------|-----------------|
| ⚡ **`configs/quick.yaml`** | Fast overview | 2 workers, single-pass synthesis, no critic |
| 🔬 **`configs/deep.yaml`** | Thorough investigation | 8 workers, 25 researcher iterations, tournament depth 4 |
| 🎯 **`configs/careful.yaml`** | High accuracy | Low temperature (0.4), extended critic loop (4 cycles) |
| 💻 **`configs/code-analysis.yaml`** | Codebase research | Higher grep/search limits, low temperature |
| 🚀 **`configs/parallel-blitz.yaml`** | Maximum parallelism | 10 workers, batch size 8, tournament depth 4 |
| 📦 **`configs/default-research/`** | Full config package | All tools externalized as JS — same behavior as defaults |

### 🏆 Synthesis strategies

- 🏆 **Tournament** — findings are paired and merged across multiple rounds of worker processes, then a final synthesizer produces the report. Better for large finding sets (10+).
- ⚡ **Single-pass** — one synthesizer receives all findings at once. Faster and simpler for small to medium finding sets.

## 🗂️ Project Structure

```
src/
├── index.ts               # CLI entry point
├── swarm-runner.ts         # Top-level runner: config → tools → orchestrator → result
├── bridge-tools.ts         # Auto-generates bridge tools from topology edges
├── tool-loader.ts          # Dynamic loading of external JS tool files
├── tool-registry.ts        # Maps tool names to handlers (built-in + external)
├── agent-loop.ts           # Generic ReAct loop (shared by all agents)
├── agent-factory.ts        # Creates agent configs, spawns workers
├── worker-pool.ts          # Manages concurrent worker processes
├── worker.ts               # Worker process entry point (child process)
├── orchestrator.ts         # Wires orchestrator tools, starts the loop
├── topology.ts             # Validates and resolves topology edges
├── context.ts              # SQLite context store, event logging
├── knowledge-store.ts      # Vector-kv HTTP client for session knowledge
├── token-budget.ts         # Token estimation, budget derivation, compaction
├── llm.ts                  # OpenAI client config
├── logger.ts               # Structured logging
├── setup.ts                # SearXNG Docker setup script
├── config/
│   ├── types.ts            # SwarmConfig type definitions
│   ├── defaults.ts         # Built-in default config
│   ├── loader.ts           # YAML loading, config package loading, deep merge
│   ├── validate.ts         # Config validation (refs, cycles, file paths)
│   └── index.ts            # Re-exports
├── synthesis/
│   └── strategies.ts       # Tournament, single-pass, and external strategy loading
├── nudge/
│   └── orchestrator-nudge.ts  # Default orchestrator nudge strategy
├── tools/                  # Built-in tool implementations (used as defaults)
│   ├── webSearch.ts        # SearXNG search
│   ├── fetchPage.ts        # Web page fetcher
│   ├── grepCode.ts         # Regex code search via vector-kv
│   ├── searchCode.ts       # Semantic code search via vector-kv
│   ├── queryKnowledge.ts   # Query session knowledge store
│   ├── submitFinding.ts    # Terminates researcher with finding
│   ├── submitCritique.ts   # Terminates critic with critique
│   └── submitReport.ts     # Writes final report to disk
└── prompts/                # Built-in system prompts (defaults)
    ├── orchestrator.md
    ├── researcher.md
    ├── synthesizer.md
    └── critic.md

configs/
├── quick.yaml              # ⚡ Fast overview preset
├── deep.yaml               # 🔬 Thorough investigation preset
├── careful.yaml            # 🎯 High-accuracy preset
├── code-analysis.yaml      # 💻 Codebase research preset
├── parallel-blitz.yaml     # 🚀 Maximum parallelism preset
└── default-research/       # 📦 Full config package (all tools externalized)
    ├── swarm.yaml
    ├── tools/*.js
    ├── prompts/*.md
    ├── strategies/tournament.js
    └── nudges/orchestrator.js
```

## 🔧 Extending

### 📦 Create a config package

The easiest way to customize is to create a config package. Copy `configs/default-research/` as a starting point:

```bash
cp -r configs/default-research configs/my-swarm
```

Then modify `swarm.yaml`, add/remove tools in `tools/`, edit prompts in `prompts/`, and run with `--config configs/my-swarm`.

### ➕ Add a new tool

Create a JS file in your config package's `tools/` directory:

```javascript
// tools/my_tool.js
export const schema = {
  type: "function",
  function: {
    name: "my_tool",
    description: "Does something useful",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

export async function handler(args, ctx) {
  const response = await ctx.fetch(`https://api.example.com?q=${args.query}`);
  return { result: await response.json() };
}
```

Reference it in `swarm.yaml`:

```yaml
tools:
  my_tool:
    enabled: true
    file: "tools/my_tool.js"
    defaults: {}
```

### 🔀 Change the research flow

Redefine topology edges in your config. For example, to skip the critic loop:

```yaml
agents:
  orchestrator:
    tools: [research_question, synthesize_findings, submit_final_report]

topology:
  edges:
    - { from: orchestrator, to: researcher, via: research_question, cardinality: fan-out }
    - { from: orchestrator, to: synthesizer, via: synthesize_findings, cardinality: single,
        strategy: { type: single-pass } }
  terminal: { agent: orchestrator, tool: submit_final_report }
```

### 🔄 Swap the LLM

Change `BASE_URL` and `MODEL_NAME` in `.env`, or set them in your config under `global.model` and `global.baseUrl`. Any OpenAI-compatible endpoint works (vLLM, Ollama, OpenAI, etc.).

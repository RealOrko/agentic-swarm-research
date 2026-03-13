# Agentic Swarm Research

A multi-agent research system that takes a question, breaks it into sub-questions, researches each one via web search and/or semantic code search, synthesizes the findings, and produces a critique-reviewed markdown report.

The entire system — agents, tools, topology, synthesis strategy — is configurable via YAML. Partial configs are deep-merged with built-in defaults, so you only specify what you want to change.

## Architecture

The system uses a tool-call-driven orchestration pattern. The **orchestrator** is a persistent agent loop whose available tools define the flow. Other agents (researcher, synthesizer, critic) are invoked as tools, each running their own agent loop in worker processes.

```
User question
  └─ Orchestrator
       ├─ research_question(q1) ──► Researcher ──► web_search / fetch_page ──► submit_finding
       ├─ research_question(q2) ──► Researcher ──► grep_code / search_code ──► submit_finding
       │        (parallel fan-out, mixed web + code research)
       ├─ synthesize_findings ──► Tournament or Single-pass synthesis
       │        tournament: pairwise merge across worker pool
       │        single-pass: one synthesizer processes all findings
       ├─ critique ────────────► Critic ────────► submit_critique
       │        (loop if gaps found, configurable max cycles)
       └─ submit_final_report ─► results/<date>-<slug>/report.md
```

### Agents

| Agent | Role | Execution | Tools |
|-------|------|-----------|-------|
| **Orchestrator** | Decomposes goal, dispatches work, manages flow | in-process | `research_question`, `synthesize_findings`, `critique`, `submit_final_report` |
| **Researcher** | Investigates a sub-question via web/code search | worker | `web_search`, `fetch_page`, `grep_code`, `search_code`, `query_knowledge`, `submit_finding` |
| **Synthesizer** | Combines findings into a coherent narrative | worker | _(none — text response)_ |
| **Critic** | Reviews synthesis for gaps and quality | worker | `submit_critique` |

### Key Design Decisions

- **Tool calls as structured output** — all agent-to-agent communication happens via tool call arguments, avoiding free-text parsing
- **YAML-configurable topology** — agent wiring, tool defaults, synthesis strategy, and iteration limits are all defined in config files that deep-merge with defaults
- **Worker pool** — researcher, synthesizer, and critic agents run as child processes with configurable concurrency (`maxWorkers`) and timeouts
- **Tournament synthesis** — large finding sets are merged pairwise across multiple rounds before a final synthesis pass, improving quality on broad topics
- **Token budget management** — each agent gets a fraction of the model's context window; messages are compacted (replaced with summaries) when the budget is exceeded
- **Shared SQLite context** — a structured store + append-only event log that traces every tool call and result for debugging
- **Prompts as markdown files** — agent system prompts live in `src/prompts/*.md` for easy editing without touching code
- **Semantic code search via [vector-kv](https://github.com/RealOrko/vector-kv)** — codebases are pre-indexed into vector-kv and queried semantically at search time

## Prerequisites

- Node.js >= 18
- Docker (for SearXNG search engine)
- An OpenAI-compatible LLM endpoint (local or remote)
- [vector-kv](https://github.com/RealOrko/vector-kv) — for semantic code search (optional)

## Setup

1. Install dependencies and link the CLI:

```bash
npm install
npm link
```

This makes the `agentic-research` command available globally.

2. Create a `.env` file:

```
BASE_URL=http://localhost:8000/v1
MODEL_NAME=mistral-small-24b
SEARXNG_URL=http://localhost:8080
```

3. Start SearXNG (self-hosted search engine):

```bash
npm run setup
```

This pulls and runs a SearXNG Docker container with JSON API enabled. The container restarts automatically unless stopped.

## Usage

```
agentic-research [options] "<research question>"

OPTIONS
  --config <path>       Path to swarm YAML config file (default: built-in defaults)
  --codebase <path>     Path to a codebase directory. Automatically indexes it
                        into vector-kv and enables semantic code search tools.
  --glob <pattern>      Glob filter for --codebase indexing (e.g. "*.ts")
  --vector-key <key>    Use an existing vector-kv key (cannot combine with --codebase)
  --help, -h            Show this help message

ENVIRONMENT
  BASE_URL      LLM endpoint (default: http://localhost:8000/v1)
  MODEL_NAME    Model to use (default: mistral-small-24b)
  SEARXNG_URL   SearXNG instance for web search
  MAX_WORKERS   Max parallel worker agents (default: 5)
```

### Examples

```bash
# Pure web research (built-in defaults)
agentic-research "What are the leading approaches to quantum computing?"

# Quick overview with fewer workers and no critic
agentic-research --config configs/quick.yaml "What is WebAssembly?"

# Deep investigation with tournament synthesis
agentic-research --config configs/deep.yaml "Compare modern JavaScript bundlers"

# Auto-index and research a codebase
agentic-research --codebase ./my-project "How does the parser handle errors?"

# Index only TypeScript files
agentic-research --codebase ./my-project --glob "*.ts" "Analyze the error handling"

# Use a previously indexed codebase
agentic-research --vector-key my-project "How does the parser handle errors?"

# Code-focused analysis with higher grep/search limits
agentic-research --config configs/code-analysis.yaml --codebase ./my-project \
  "What are the best practices for error handling in this codebase?"
```

### Output

Results are written to `./results/<date>-<slug>/`:

- **`report.md`** — the final research report in markdown
- **`context.json`** — full execution trace (store state + event log)

## Configuration

The system ships with built-in defaults that work out of the box. To customize behavior, create a YAML config file and pass it via `--config`. Only specify what you want to override — everything else inherits from defaults.

### Config file structure

```yaml
version: "1"

global:
  temperature: 0.7            # LLM temperature for all agents
  limits:
    maxWorkers: 5              # Max concurrent worker processes
    workerTimeoutMs: 300000    # Worker timeout (5 min)
    toolBatchSize: 5           # Max parallel tool calls per iteration

tools:
  web_search:
    defaults:
      topResults: 8            # Number of search results to return
  fetch_page:
    defaults:
      maxContentChars: 4000    # Max chars to extract from a page

agents:
  orchestrator:
    limits:
      maxIterations: 100       # Max orchestrator loop iterations
      toolCallBudget: 20       # Max total tool calls
      maxNudges: 3             # Max wrap-up nudges before force-stop
  researcher:
    limits:
      maxIterations: 15
      toolCallBudget: 12

topology:
  edges:
    - { from: orchestrator, to: researcher, via: research_question, cardinality: fan-out }
    - { from: orchestrator, to: synthesizer, via: synthesize_findings, cardinality: single }
    - { from: orchestrator, to: critic, via: critique, cardinality: single }
    - { from: critic, to: orchestrator, via: feedback,
        condition: "result.approved === false", maxCycles: 2 }
  terminal: { agent: orchestrator, tool: submit_final_report }

synthesis:
  default: tournament          # or "single-pass"
  strategies:
    tournament: { maxDepth: 3, baseCaseSize: 3, synthesizerAgent: synthesizer }
    single-pass: { synthesizerAgent: synthesizer }
```

### Preset configs

| Config | Use case | Key differences |
|--------|----------|-----------------|
| **`configs/quick.yaml`** | Fast overview | 2 workers, single-pass synthesis, no critic, fewer search results |
| **`configs/deep.yaml`** | Thorough investigation | 8 workers, 25 researcher iterations, tournament synthesis (depth 4) |
| **`configs/careful.yaml`** | High accuracy | Low temperature (0.4), extended critic loop (4 cycles), extra nudges |
| **`configs/code-analysis.yaml`** | Codebase research | Higher grep/search limits, low temperature, requires `--vector-key` |
| **`configs/parallel-blitz.yaml`** | Maximum parallelism | 10 workers, batch size 8, tournament synthesis (depth 4) |

### Synthesis strategies

- **Tournament** — findings are paired and merged across multiple rounds of worker processes, then a final synthesizer produces the report. Better for large finding sets (10+) where a single pass would exceed context limits.
- **Single-pass** — one synthesizer receives all findings at once. Faster and simpler, good for small to medium finding sets.

## Project Structure

```
src/
├── index.ts               # CLI entry point
├── swarm-runner.ts         # Top-level runner: config → orchestrator → result
├── orchestrator.ts         # Wires orchestrator tools, starts the loop
├── agent-loop.ts           # Generic ReAct loop (shared by all agents)
├── agent-factory.ts        # Creates agent configs from SwarmConfig definitions
├── tool-registry.ts        # Maps tool names to handlers based on config
├── topology.ts             # Validates and resolves topology edges
├── worker-pool.ts          # Manages concurrent worker processes
├── worker.ts               # Worker process entry point (child process)
├── tournament.ts           # Tournament synthesis: pairwise merge rounds
├── context.ts              # SQLite context store, event logging
├── knowledge-store.ts      # Vector-kv HTTP client for session knowledge
├── token-budget.ts         # Token estimation, budget derivation, compaction
├── llm.ts                  # OpenAI client config
├── logger.ts               # Structured logging
├── setup.ts                # SearXNG Docker setup script
├── config/
│   ├── types.ts            # SwarmConfig type definitions
│   ├── defaults.ts         # Built-in default config
│   ├── loader.ts           # YAML loading + deep merge with defaults
│   ├── validate.ts         # Config validation (refs, cycles, prompt paths)
│   └── index.ts            # Re-exports
├── synthesis/
│   └── strategies.ts       # Tournament and single-pass strategy implementations
├── tools/
│   ├── webSearch.ts        # SearXNG search
│   ├── fetchPage.ts        # Web page fetcher
│   ├── grepCode.ts         # Regex code search
│   ├── searchCode.ts       # Semantic code search via vector-kv
│   ├── queryKnowledge.ts   # Query session knowledge store
│   ├── research.ts         # Researcher agent (spawned as worker)
│   ├── synthesize.ts       # Synthesis agent
│   ├── critique.ts         # Critic agent
│   ├── submitFinding.ts    # Terminates researcher with finding
│   ├── submitCritique.ts   # Terminates critic with critique
│   └── submitReport.ts     # Writes final report to disk
└── prompts/
    ├── orchestrator.md     # Orchestrator system prompt
    ├── researcher.md       # Researcher system prompt
    ├── synthesizer.md      # Synthesizer system prompt
    └── critic.md           # Critic system prompt

configs/
├── quick.yaml              # Fast overview preset
├── deep.yaml               # Thorough investigation preset
├── careful.yaml            # High-accuracy preset
├── code-analysis.yaml      # Codebase research preset
└── parallel-blitz.yaml     # Maximum parallelism preset
```

## Extending

### Change the research flow

Create a YAML config file that redefines the topology edges. For example, to skip the critic loop:

```yaml
topology:
  edges:
    - { from: orchestrator, to: researcher, via: research_question, cardinality: fan-out }
    - { from: orchestrator, to: synthesizer, via: synthesize_findings, cardinality: single }
  terminal: { agent: orchestrator, tool: submit_final_report }
```

### Add a new agent

1. Create a system prompt in `src/prompts/`
2. Add the agent definition to your config file (or `src/config/defaults.ts`)
3. Add a topology edge connecting it to the orchestrator
4. Create a tool handler in `src/tools/` if the agent needs custom invocation logic

### Swap the LLM

Change `BASE_URL` and `MODEL_NAME` in `.env`, or set them in your config file under `global.model` and `global.baseUrl`. Any OpenAI-compatible endpoint works (vLLM, Ollama, OpenAI, etc.).

### Swap the search engine

Replace the `handler` in `src/tools/webSearch.ts`. The tool interface is simple: takes a query string, returns `{ query, results: [{ title, url, snippet }] }`.

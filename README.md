# Agentic Swarm Research

A multi-agent research system that takes a question, breaks it into sub-questions, researches each one via web search and/or semantic code search, synthesizes the findings, and produces a critique-reviewed markdown report.

## Architecture

The system uses a tool-call-driven orchestration pattern. The **orchestrator** is a persistent agent loop whose available tools define the flow. Other agents (researcher, synthesizer, critic) are invoked as tools, each running their own agent loop internally.

```
User question
  └─ Orchestrator
       ├─ research_question(q1) ──► Researcher ──► web_search ──► submit_finding
       ├─ research_question(q2) ──► Researcher ──► web_search ──► submit_finding
       ├─ search_code(q3) ─────► vector-kv semantic search ──► code chunks
       │        (parallel, mixed web + code research)
       ├─ synthesize_findings ──► Synthesizer ──► combined narrative
       ├─ critique ────────────► Critic ────────► submit_critique
       │        (loop if gaps found, max 2 cycles)
       └─ submit_final_report ─► results/<date>-<slug>/report.md
```

### Agents

| Agent | Role | Tools |
|-------|------|-------|
| **Orchestrator** | Decomposes goal, dispatches work, manages flow | `search_code`, `research_question`, `synthesize_findings`, `critique`, `submit_final_report` |
| **Researcher** | Investigates a sub-question via web search | `web_search`, `submit_finding` |
| **Synthesizer** | Combines multiple findings into a coherent narrative | _(none — single LLM call)_ |
| **Critic** | Reviews synthesis for gaps and quality | `submit_critique` |

### Key Design Decisions

- **Tool calls as structured output** — all agent-to-agent communication happens via tool call arguments, avoiding free-text parsing
- **`terminates` flag** — tools like `submit_finding` and `submit_final_report` immediately end their agent loop when called
- **Shared `Context`** — a key/value store + append-only event log that traces every tool call and result for debugging
- **Prompts as markdown files** — agent system prompts live in `src/prompts/*.md` for easy editing without touching code
- **Semantic code search via [vector-kv](https://github.com/RealOrko/vector-kv)** — codebases are pre-indexed into vector-kv and queried semantically at search time, avoiding expensive full-codebase reads

## Prerequisites

- Node.js >= 18
- Docker (for SearXNG search engine)
- An OpenAI-compatible LLM endpoint (local or remote)
- [vector-kv](https://github.com/RealOrko/vector-kv) — for semantic code search

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

4. Index your codebase into vector-kv:

```bash
vector-kv index my-project /path/to/codebase
```

## Usage

```
agentic-research [options] "<research question>"

OPTIONS
  --vector-kv-key <key>   Vector-KV key for semantic code search
  --help, -h              Show help

ENVIRONMENT
  BASE_URL      LLM endpoint (default: http://localhost:8000/v1)
  MODEL_NAME    Model to use (default: mistral-small-24b)
  SEARXNG_URL   SearXNG instance for web search
  MAX_WORKERS   Max parallel worker agents (default: 5)
```

### Examples

```bash
# Pure web research
agentic-research "What are the leading approaches to quantum computing?"

# Code + web research
agentic-research --vector-kv-key my-project "How could we improve error handling in this codebase?"

# Architecture review
agentic-research --vector-kv-key my-project "Analyze the authentication flow and suggest security improvements"
```

### Output

Results are written to `./results/<date>-<slug>/`:

- **`report.md`** — the final research report in markdown
- **`context.json`** — full execution trace (store state + event log)

## Project Structure

```
src/
├── index.ts               # CLI entry point
├── orchestrator.ts         # Wires orchestrator tools, starts the loop
├── agent-loop.ts           # Generic ReAct loop (shared by all agents)
├── context.ts              # Context type, event logging helpers
├── knowledge-store.ts      # Vector-kv HTTP client for session knowledge
├── llm.ts                  # OpenAI client config
├── setup.ts                # SearXNG Docker setup script
├── tools/
│   ├── searchCode.ts       # Semantic code search via vector-kv CLI
│   ├── webSearch.ts        # SearXNG search
│   ├── fetchPage.ts        # Web page fetcher
│   ├── research.ts         # Web researcher agent
│   ├── queryKnowledge.ts   # Query session knowledge store
│   ├── synthesize.ts       # Synthesis agent
│   ├── critique.ts         # Critic agent
│   └── submitReport.ts     # Writes report to disk
└── prompts/
    ├── orchestrator.md     # Orchestrator system prompt
    ├── researcher.md       # Web researcher system prompt
    ├── synthesizer.md      # Synthesizer system prompt
    └── critic.md           # Critic system prompt
```

## Extending

### Add a new agent

1. Create a tool in `src/tools/` that runs `agentLoop()` internally
2. Add a system prompt in `src/prompts/`
3. Register the tool in `orchestrator.ts`

The orchestrator will use it based on its prompt instructions and the tool's description.

### Change the flow

The topology is defined by which tools the orchestrator has access to and what its system prompt says to do with them. Edit `src/prompts/orchestrator.md` to change the workflow, or modify `orchestrator.ts` to add/remove tools.

### Swap the LLM

Change `BASE_URL` and `MODEL_NAME` in `.env`. Any OpenAI-compatible endpoint works (vLLM, Ollama, OpenAI, etc.).

### Swap the search engine

Replace the `handler` in `src/tools/webSearch.ts`. The tool interface is simple: takes a query string, returns `{ query, results: [{ title, url, snippet }] }`.

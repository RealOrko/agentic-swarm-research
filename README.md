# Agentic Swarm Research

A multi-agent research system that takes a question, breaks it into sub-questions, researches each one via web search and/or codebase analysis, synthesizes the findings, and produces a critique-reviewed markdown report.

## Architecture

The system uses a tool-call-driven orchestration pattern. The **orchestrator** is a persistent agent loop whose available tools define the flow. Other agents (researcher, code researcher, synthesizer, critic) are invoked as tools, each running their own agent loop internally.

```
User question
  └─ Orchestrator
       ├─ research_question(q1) ──► Researcher ──► web_search ──► submit_finding
       ├─ research_question(q2) ──► Researcher ──► web_search ──► submit_finding
       ├─ research_code(q3) ────► Code Researcher ──► list_files / read_file / grep_code ──► submit_finding
       │        (parallel, mixed web + code research)
       ├─ synthesize_findings ──► Synthesizer ──► combined narrative
       ├─ critique ────────────► Critic ────────► submit_critique
       │        (loop if gaps found, max 2 cycles)
       └─ submit_final_report ─► results/<date>-<slug>/report.md
```

### Agents

| Agent | Role | Tools |
|-------|------|-------|
| **Orchestrator** | Decomposes goal, dispatches work, manages flow | `research_question`, `research_code`, `synthesize_findings`, `critique`, `submit_final_report` |
| **Researcher** | Investigates a sub-question via web search | `web_search`, `submit_finding` |
| **Code Researcher** | Investigates a sub-question by exploring a codebase | `list_files`, `read_file`, `grep_code`, `submit_finding` |
| **Synthesizer** | Combines multiple findings into a coherent narrative | _(none — single LLM call)_ |
| **Critic** | Reviews synthesis for gaps and quality | `submit_critique` |

### Key Design Decisions

- **Tool calls as structured output** — all agent-to-agent communication happens via tool call arguments, avoiding free-text parsing
- **`terminates` flag** — tools like `submit_finding` and `submit_final_report` immediately end their agent loop when called
- **Shared `Context`** — a key/value store + append-only event log that traces every tool call and result for debugging
- **Prompts as markdown files** — agent system prompts live in `src/prompts/*.md` for easy editing without touching code
- **Path-scoped code access** — code research tools are sandboxed to the provided repo path

## Prerequisites

- Node.js >= 18
- Docker (for SearXNG search engine)
- An OpenAI-compatible LLM endpoint (local or remote)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file:

```
BASE_URL=http://localhost:8000/v1
MODEL_NAME=qwen3-coder-30b-a3b
SEARXNG_URL=http://localhost:8080
```

3. Start SearXNG (self-hosted search engine):

```bash
npm run setup
```

This pulls and runs a SearXNG Docker container with JSON API enabled. The container restarts automatically unless stopped.

## Usage

### Web research

```bash
npm run research -- "Your research question here"
```

### Code + web research

```bash
npm run research -- --repo /path/to/codebase "Your question about the code"
```

The `--repo` flag enables the `research_code` tool. The orchestrator decides per sub-question whether to use web search, code analysis, or both.

### Examples

```bash
# Pure web research
npm run research -- "What are the leading approaches to quantum computing?"

# Code analysis with web context
npm run research -- --repo /path/to/myapp "How could we improve error handling in this codebase?"

# Architecture review
npm run research -- --repo /path/to/myapp "Analyze the authentication flow and suggest security improvements"
```

### Output

Results are written to `./results/<date>-<slug>/`:

- **`report.md`** — the final research report in markdown
- **`context.json`** — full execution trace (store state + event log)

## Project Structure

```
src/
├── index.ts               # CLI entry point (parses --repo flag)
├── orchestrator.ts         # Wires orchestrator tools, starts the loop
├── agent-loop.ts           # Generic ReAct loop (shared by all agents)
├── context.ts              # Context type, event logging helpers
├── llm.ts                  # OpenAI client config
├── setup.ts                # SearXNG Docker setup script
├── tools/
│   ├── webSearch.ts        # SearXNG search
│   ├── research.ts         # Web researcher agent
│   ├── researchCode.ts     # Code researcher agent
│   ├── codeTools.ts        # list_files, read_file, grep_code tools
│   ├── synthesize.ts       # Synthesis agent
│   ├── critique.ts         # Critic agent
│   └── submitReport.ts     # Writes report to disk
└── prompts/
    ├── orchestrator.md     # Orchestrator system prompt
    ├── researcher.md       # Web researcher system prompt
    ├── code-researcher.md  # Code researcher system prompt
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

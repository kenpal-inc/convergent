# convergent

[![CI](https://github.com/kenpal-inc/convergent/actions/workflows/test.yml/badge.svg)](https://github.com/kenpal-inc/convergent/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-%23fbf0df?logo=bun)](https://bun.sh/)

Autonomous development orchestrator for Claude Code. Give it a codebase context and a goal — it decomposes work into tasks and uses **tournament-based convergent evolution**: multiple competing implementations race in parallel git worktrees, each verified objectively (typecheck, lint, tests), and an AI judge selects the fittest survivor.

## How It Works

```
Phase 0: Task Generation
  Input: --context (files/dirs) + --goal (natural language) + --instructions (optional)
  → Researches external references (GitHub issues, URLs)
  → Generates a structured task queue with dependency graph
  → Assigns task types: code | explore | command
        │
        ▼
┌──────────────────────────────────────────────────────────────────┐
│ Branching by task type:                                          │
│                                                                  │
│ [code]    ── Phase T (tournament) → Verify → Phase C → Commit    │
│ [explore] ── Direct execution (investigation → findings.md)      │
│ [command] ── Direct execution (deploy, run scripts, etc.)        │
└──────────────────────────────────────────────────────────────────┘

code task flow:
  Phase T: Tournament
    → Creates N parallel git worktrees from the current commit
    → Each competitor implements the task with a different strategy
    → Each is verified in its worktree (typecheck, lint, tests, format)
    → AI judge compares passing implementations and selects the best
    → Winner's changes are applied to the main working tree
          │
          ▼
  Verify: Main-tree verification
    → Runs verification in the main working tree after applying winner
          │
          ▼
  Phase C: Multi-Persona Code Review
    → 3 specialist reviewers audit in parallel
    → All approved → commit / changes_requested → retry

explore task flow:
  → Investigates using all user-permitted tools (Playwright CLI, MCP tools, etc.)
  → Records results to findings.md → auto-propagated to dependent tasks

command task flow:
  → Executes the specified command → reports success/failure

Loops until all tasks complete or budget is exhausted.
```

### What Is Convergent Evolution?

The core idea: when multiple independent implementations with different strategies solve the same problem, the elements they **converge on** are likely the best approach. Disagreements are resolved by an AI judge that evaluates code quality, correctness, and robustness.

Competitor strategies are assigned based on task complexity:

| Complexity | Competitors | Use Case |
|------------|-------------|----------|
| `trivial` | 1 (single implementation) | Single file, simple changes |
| `standard` | 2 (pragmatist, thorough) | 2–5 files, moderate logic |
| `complex` | 3 (pragmatist, thorough, deconstructor) | 6+ files, architectural changes |

### Task Types

Phase 0 analyzes the goal and automatically assigns the appropriate type to each task:

| Type | Purpose | Tournament | Verify | Review |
|------|---------|------------|--------|--------|
| `code` | Code implementation/modification (default) | N competing implementations | typecheck/lint/test/format | Multi-persona review |
| `explore` | Exploratory testing, investigation, information gathering | Skipped | None | None |
| `command` | Deploy, migration, script execution | Skipped | None | None |

Results from `explore` tasks (`findings.md`) are automatically injected into the context of dependent tasks. For example, "find bugs via exploratory testing → fix them in code" flows naturally.

Tools permitted in the user's `~/.claude/settings.json` (Playwright CLI, MCP tools, etc.) are automatically available to `explore` and `command` tasks.

## Installation

```bash
# Install via curl (requires Bun)
curl -fsSL https://raw.githubusercontent.com/kenpal-inc/convergent/main/install.sh | bash
```

### Prerequisites

- [Bun](https://bun.sh/) (>=1.0.0)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude` command)

## Quick Start

```bash
# Run on your project
convergent \
  --context "docs/,src/,README.md" \
  --goal "Implement user authentication with JWT tokens"
```

## Usage

```bash
# Fully autonomous execution
convergent \
  --context "docs/,src/,memo/remaining-tasks.md" \
  --goal "Implement all remaining tasks in remaining-tasks.md"

# Natural language instructions only (goal and context auto-derived)
convergent \
  --instructions "Switch auth from JWT to session-based. Add a role field to the user model"

# Read instructions from a file (e.g., TODO.md)
convergent --instructions-file ./TODO.md

# Exploratory testing → bug fix → deploy (mixed explore/code/command tasks)
convergent \
  --instructions "Run exploratory tests on production with Playwright CLI, fix any bugs found, then deploy"

# Separate goal (direction) and instructions (specifics)
convergent \
  --context "src/" --goal "Improve e-commerce backend" \
  --instructions "Switch auth from JWT to session-based. Add a role field to the user model"

# Generate task queue only (review before executing)
convergent \
  --context "src/" \
  --goal "Fix all TypeScript type errors" \
  --review

# Resume after interruption (Ctrl+C)
convergent --resume

# Reset failed tasks and retry
convergent --resume --retry-failed

# Plan generation only (no implementation)
convergent \
  --context "src/" \
  --goal "Implement authentication" \
  --dry-run

# Refine task queue with natural language (after --review)
convergent \
  --refine "Remove task-001, it's unnecessary. Change task-003 complexity to standard"

# Set budget and model
convergent \
  --context "." \
  --goal "Add dark mode support" \
  --max-budget 20.00 \
  --model opus
```

### Options

| Option | Description |
|--------|-------------|
| `--context <paths>` | Comma-separated files/directories to analyze |
| `--goal <text>` | What to achieve (natural language) |
| `--instructions <text>` | Specific instructions for task generation (natural language) |
| `--instructions-file <path>` | Read instructions from a file (e.g., TODO.md) |
| `--resume` | Resume from `.convergent/state.json` |
| `--retry-failed` | With `--resume`, reset failed/blocked tasks to pending |
| `--review` | Stop after Phase 0 (task generation) for review |
| `--dry-run` | Run Phase 0 + Phase A only (plan generation, no implementation) |
| `--refine <text>` | Refine the latest task queue with natural language |
| `--config <path>` | Custom config file |
| `--max-budget <USD>` | Budget cap (default: $50) |
| `--model <model>` | Override model for all phases |
| `--verbose` | Enable debug logging |

### Review → Refine → Execute Workflow

Combine `--review` and `--refine` to inspect and adjust the task queue before execution:

```bash
# 1. Generate and review task queue
convergent \
  --context "src/" --goal "Implement authentication" --review

# 2. Refine with natural language (repeatable)
convergent \
  --refine "Remove task-001. Add E2E test acceptance criteria to task-003"

# 3. Execute when satisfied
convergent --resume
```

`--refine` can be run multiple times. Each invocation reads the latest `tasks.json` and modifies it based on your instructions.

### Dry Run → Execute Workflow

Use `--dry-run` to run Phase 0 (task generation) only, then review the task queue before executing:

```bash
# 1. Generate tasks
convergent \
  --context "src/" --goal "Implement authentication" --dry-run

# 2. Review task queue
cat .convergent/latest/tasks.json | jq .

# 3. Execute
convergent --resume
```

## Configuration

Place a `convergent.config.json` in your project root to customize:

```json
{
  "models": {
    "planner": "opus",
    "executor": "opus"
  },
  "budget": {
    "total_max_usd": 75.00,
    "per_task_max_usd": 15.00,
    "plan_max_usd": 2.00,
    "execution_max_usd": 5.00,
    "review_max_usd": 2.00,
    "per_review_persona_max_usd": 0.80
  },
  "parallelism": {
    "tournament_timeout_seconds": 1800,
    "explore_timeout_seconds": 1200,
    "command_timeout_seconds": 1200
  },
  "tournament": {
    "competitors": 3,
    "strategies": ["pragmatist", "thorough", "deconstructor"]
  },
  "verification": {
    "auto_detect": true,
    "commands": [],
    "max_retries": 2
  },
  "review": {
    "enabled": true,
    "max_retries": 2,
    "personas": ["correctness", "security", "maintainability"]
  },
  "git": {
    "auto_commit": true,
    "create_branch": false,
    "create_pr": false
  }
}
```

### Verification Commands

By default, convergent auto-detects your project's quality checks (looking for `tsconfig.json`, `package.json` scripts for lint/test, and prettier). Override with `verification.commands`:

```json
{
  "verification": {
    "auto_detect": false,
    "commands": ["npm run lint", "npm run typecheck", "npm test"],
    "max_retries": 2
  }
}
```

Each tournament competitor is verified in its own worktree. The winner is then verified again in the main working tree. On failure, error output is fed back as context for review retry.

## Output

All runtime data is stored in `.convergent/` (already in `.gitignore`). Each run gets a timestamped directory so you can review past runs:

```
.convergent/
├── latest -> runs/2026-02-12T20-30-00  # symlink to latest run
└── runs/
    ├── 2026-02-12T20-30-00/            # first run
    │   ├── tasks.json
    │   ├── state.json
    │   ├── budget.json
    │   ├── learnings.json               # cross-task learning data
    │   ├── reports/
    │   │   ├── summary.md
    │   │   └── task-001.md
    │   └── logs/
    │       ├── orchestrator.log
    │       ├── phase0/
    │       │   ├── raw_output.json
    │       │   └── project_summary.md   # project structure summary
    │       └── task-task-001/
    │           ├── competitor-0.log      # pragmatist implementation log
    │           ├── competitor-1.log      # thorough implementation log
    │           ├── judge.json            # AI judge decision + rationale
    │           ├── verify.log
    │           ├── review-correctness.json
    │           ├── review-security.json
    │           ├── review-maintainability.json
    │           └── review.json           # merged final review
    └── 2026-02-12T21-45-00/            # second run
        └── ...
```

`--resume` follows the `latest` symlink to pick up the most recent run.

## Intelligent Features

### Natural Language Instructions

While `--goal` sets the overall direction, `--instructions` / `--instructions-file` add specific implementation directives. Combine automated codebase analysis with human intent for targeted task generation:

- **Inline**: `--instructions "Switch auth from JWT to session-based"`
- **From file**: `--instructions-file ./TODO.md` — feed existing TODO lists or issues directly
- `--instructions` alone is sufficient — `--goal` auto-derives from the first line, `--context` defaults to `.`
- Instructions are injected as a `## User Instructions` section in the Phase 0 prompt, giving them priority during task generation

### Context Quality

- **Import dependency tracing**: Traces import/require from task `context_files` to discover related files automatically, included in tournament competitor prompts
- **Project structure summary**: Phase 0 auto-generates a listing of source files with one-line descriptions, giving competitors a bird's-eye view
- **Tool access**: Tournament competitors can use Read, Write, Edit, Glob, Grep, and Bash tools to explore and modify the codebase
- **Signature extraction**: Source files in directories have their export/type/interface/function signatures extracted (instead of just the first 100 lines), providing an overview of each file's public API

### Cross-Task Learning

- **Review feedback propagation**: Issues raised during Phase C reviews are accumulated and included as "lessons learned" in subsequent Phase B prompts
- **Failure pattern accumulation**: Failure patterns from Phase A/B/verification/review are recorded to prevent repeating the same mistakes
- **Deduplication**: Similar learning entries are automatically deduplicated to prevent prompt bloat

### Execution Efficiency

- **Parallel tournament**: Multiple competitors implement simultaneously in isolated git worktrees
- **Convergence analysis**: When competitors modify the same files, convergence ratio is measured — high agreement confirms solution quality
- **Parallel verification**: lint, typecheck, test, and format run in parallel to reduce verification time
- **Auto-detected verification**: Automatically discovers project tooling (tsconfig.json, lint scripts, test scripts, prettier) — no manual configuration needed
- **Differential review**: On Phase C retry, review focuses on the diff between the previous review feedback and the current changes

## Fault Tolerance

### Tournament Resilience

Graduated recovery when competitors fail:

1. **Partial success**: If some competitors fail but at least one succeeds, the tournament proceeds with the successful implementations
2. **Score-based selection**: Winner is selected by objective verification score (typecheck=30, tests=40, lint=15, format=15). On tie, AI judge breaks it by evaluating code quality
3. **Single competitor fallback**: Trivial tasks skip tournament overhead and run a single implementation

### Review Severity Filter

When Phase C review returns `changes_requested` but all issues are `info`-level (no warnings or errors), it's treated as `approved`. Prevents retry loops over trivial issues like missing `.gitkeep` files.

### No-Diff Detection

After a review fix attempt, if `git diff` shows no changes, the fix agent was unable to make effective changes — the task is approved and execution moves on. Prevents infinite retry loops.

### Smart Circuit Breaker

Tournament failures where no competitor produces valid output are counted toward the circuit breaker. Partial failures (some competitors fail but winner exists) are not counted. Threshold: 3 consecutive substantive failures.

### Exponential Backoff Retry

When Claude CLI calls hit rate limits, connection errors, or server errors (429/502/503/529), requests are retried with exponential backoff (3s → 6s → 12s, up to 2 retries). Prevents unnecessary failures from transient issues.

### Verification Timeout

Verification commands (lint, typecheck, test) have a configurable timeout (default: 5 minutes). Prevents the orchestrator from hanging due to infinite loops in tests. Set via `verification.timeout_seconds`.

### `--retry-failed`

`--resume --retry-failed` resets failed and blocked tasks to pending and re-executes them. Tasks blocked by upstream failures are cascadingly reset.

## Safety

- **Budget limits**: Per-task and total budget caps
- **Circuit breaker**: Stops after 3 consecutive task failures
- **Tournament isolation**: Each competitor runs in its own git worktree — failures can't corrupt the main tree
- **Verification gate**: Winner's changes are verified in both the worktree and the main working tree
- **Multi-persona review gate**: After verification, 3 specialist reviewers audit correctness, security, and maintainability in parallel (any rejection triggers a fix)
- **Auto-revert**: Failed task changes are automatically rolled back
- **Resumable**: State is saved on Ctrl+C, resume with `--resume`

## When to Use (and When Not to)

convergent's tournament-based approach shines in specific scenarios and is overkill in others.

### Strong Use Cases

| Scenario | Why It Works |
|----------|-------------|
| **Ambiguous requirements with multiple valid approaches** | Multiple implementations explore different design choices; the AI judge picks the best. Example: "Add real-time notifications" (WebSocket vs SSE vs polling) |
| **Large refactoring with breaking changes** | Parallel worktrees let competitors try different migration strategies safely. The one that passes verification wins |
| **Well-tested codebases** | Verification (typecheck, lint, test) acts as strong selection pressure — bad implementations are eliminated automatically |
| **Greenfield features in existing projects** | Competitors independently make architectural decisions (schema design, API structure, state management). Convergence signals which choices are natural |

### Weak Use Cases

| Scenario | Why It Doesn't Help |
|----------|-------------------|
| **Clear spec with one obvious implementation path** | All competitors write nearly identical code — tournament overhead for no benefit |
| **Projects with no tests** | No selection pressure means verification always passes — just expensive random selection |
| **Visual/UI tweaks** | Correctness is subjective and can't be verified automatically |
| **Single-file bug fixes** | Trivial tasks already skip the tournament (single competitor). Use Claude Code directly |

### Cost Profile

From real-world benchmarking (CSRF implementation on a Hono + React production codebase):

| Metric | Value |
|--------|-------|
| Tasks generated | 5-6 |
| Tournaments run | 4 |
| Total cost | ~$25-35 |
| Wall clock time | ~60 min |
| Competitors per tournament | 1 (trivial) / 2 (standard) / 3 (complex) |

Budget scales linearly with task count. The biggest cost lever is task decomposition granularity — convergent aims for 5-7 tasks by default, merging related changes into single tasks.

## Design Philosophy: No Interactive Intervention

This tool **intentionally does not support** human intervention during execution.

The rationale is simple: the tool exists to eliminate the human bottleneck and run development autonomously. If you're intervening at every step, you might as well use Claude Code directly.

Instead, it provides **observation and control** through these mechanisms:

| Mechanism | What It Provides |
|-----------|-----------------|
| `.convergent/logs/` | Post-hoc inspection (full prompt/response for every call) |
| Terminal output | Real-time observation (progress, cost, pass/fail) |
| Ctrl+C → `--resume` | Emergency stop and resume |
| `--review` flag | Pause after Phase 0 to inspect task queue |
| `--dry-run` flag | Run through Phase 0 (task generation) only, review before implementing |
| `--refine` flag | Modify task queue with natural language (repeatable) |
| Budget limits + circuit breaker | Automatic runaway prevention |

"Not knowing what's happening" is addressed by logs and terminal output. "I want to stop" is handled by Ctrl+C. If you want to change direction mid-run, stop and re-run with an updated goal — this produces better results than mid-stream intervention.

## Competitor Strategies

| Strategy | Focus |
|----------|-------|
| pragmatist | Follow the plan precisely, no deviations, ship exactly what was specified |
| thorough | Comprehensive implementation with defensive validation, edge cases, robust error recovery |
| deconstructor | Challenge assumptions, find better approaches, refactor when warranted |

Customize strategies by editing `lib/competitors.json`.

## Review Personas

Phase C code review uses these specialist reviewers in parallel:

| Review Persona | Focus |
|---------------|-------|
| correctness | Plan compliance, acceptance criteria, logic accuracy |
| security | Input validation, auth boundaries, XSS/SQLi, secret leaks |
| maintainability | Unnecessary changes, pattern consistency, dead code, error handling |

Merge rule: **strict union** — if any reviewer returns `changes_requested`, the whole review is `changes_requested`. All issues are merged and fed back to Phase B retry.

Customize review personas by editing `lib/review_personas.json`. Set `config.review.personas` to an empty array to fall back to single-reviewer mode.

## Requirements

- [Bun](https://bun.sh/) runtime (>=1.0.0)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude` command)
- Git (for auto-commit)

## License

[MIT](LICENSE)

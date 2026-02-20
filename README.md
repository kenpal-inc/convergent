# convergent

[![CI](https://github.com/kenpal-inc/convergent/actions/workflows/test.yml/badge.svg)](https://github.com/kenpal-inc/convergent/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-%23fbf0df?logo=bun)](https://bun.sh/)

Autonomous development orchestrator for Claude Code. Give it a codebase context and a goal — it decomposes work into tasks and uses a **convergent evolution** approach: multiple AI personas independently design solutions, then a synthesizer merges the best elements into an optimal implementation plan.

## How It Works

```
Phase 0: Task Generation
  Input: --context (files/dirs) + --goal (natural language) + --instructions (optional)
  → Generates a structured task queue with dependency graph
  → Assigns task types: code | explore | command
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ Branching by task type:                                     │
│                                                             │
│ [code]    ── Phase A → Phase B → Verify → Phase C → Commit  │
│ [explore] ── Direct execution (investigation → findings.md) │
│ [command] ── Direct execution (deploy, run scripts, etc.)   │
└─────────────────────────────────────────────────────────────┘

code task flow:
  Phase A: Convergent Evolution
    → Spawns 3–7 personas in parallel (each with Read/Glob/Grep access)
    → Early termination on high consensus
    → Synthesizer merges the optimal plan
          │
          ▼
  Phase B: Implementation
    → Executes the converged plan (with learnings + explore findings as context)
    → Runs verification (lint, typecheck, test) → retries on failure
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

The core idea: when multiple independent agents with different priorities analyze the same problem, the elements they **converge on** are likely the best approach. Disagreements are resolved by a synthesizer that weighs the rationale behind each perspective.

Personas are assigned based on task complexity:

| Complexity | Personas | Use Case |
|------------|----------|----------|
| `trivial` | None (direct plan generation) | Single file, simple changes |
| `standard` | pragmatist, tdd, security | 2–5 files, moderate logic |
| `complex` | All 7 personas | 6+ files, architectural changes |

### Task Types

Phase 0 analyzes the goal and automatically assigns the appropriate type to each task:

| Type | Purpose | Phase A | Verify | Review |
|------|---------|---------|--------|--------|
| `code` | Code implementation/modification (default) | Persona convergence | lint/typecheck/test | Multi-persona review |
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

Use `--dry-run` to run Phase 0 (task generation) and Phase A (plan design) only, then review plans before executing:

```bash
# 1. Generate tasks + plans
convergent \
  --context "src/" --goal "Implement authentication" --dry-run

# 2. Review plans
cat .convergent/latest/logs/task-001/synthesis.json | jq .

# 3. Execute
convergent --resume
```

## Configuration

Place a `convergent.config.json` in your project root to customize:

```json
{
  "models": {
    "planner": "sonnet",
    "persona": "sonnet",
    "synthesizer": "opus",
    "executor": "sonnet"
  },
  "budget": {
    "total_max_usd": 50.00,
    "per_task_max_usd": 10.00,
    "per_persona_max_usd": 1.00,
    "synthesis_max_usd": 2.00,
    "execution_max_usd": 5.00,
    "review_max_usd": 2.00,
    "per_review_persona_max_usd": 0.80
  },
  "parallelism": {
    "persona_timeout_seconds": 120,
    "max_parallel_tasks": 3
  },
  "verification": {
    "commands": ["bun lint", "bun typecheck", "bun test"],
    "max_retries": 2,
    "timeout_seconds": 300,
    "parallel": true
  },
  "review": {
    "enabled": true,
    "max_retries": 2,
    "personas": ["correctness", "security", "maintainability"]
  },
  "personas": {
    "trivial": [],
    "standard": ["pragmatist", "tdd", "security"],
    "complex": ["conservative", "minimalist", "tdd", "performance", "ux", "security", "pragmatist"]
  },
  "git": {
    "auto_commit": true
  }
}
```

### Verification Commands

Set your project's quality checks in `verification.commands`. The orchestrator runs these after each task implementation:

```json
{
  "verification": {
    "commands": ["npm run lint", "npm run typecheck", "npm test"],
    "max_retries": 2
  }
}
```

On failure, error output is fed back as context for a Phase B retry. After `max_retries` failures, the task is marked as failed and changes are reverted.

Set `verification.commands` to `[]` to skip verification.

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
    │       └── task-001/
    │           ├── persona-conservative.json
    │           ├── persona-tdd.json
    │           ├── persona-security.json
    │           ├── synthesis.json        # converged plan
    │           ├── execution.log
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

- **Import dependency tracing**: Traces import/require from task `context_files` to discover related files automatically, included in Phase A and Phase B prompts
- **Project structure summary**: Phase 0 auto-generates a listing of source files with one-line descriptions, giving Phase A personas a bird's-eye view
- **Persona Read tool access**: Phase A personas can use Read, Glob, and Grep tools to explore the codebase beyond the provided context
- **Signature extraction**: Source files in directories have their export/type/interface/function signatures extracted (instead of just the first 100 lines), providing an overview of each file's public API

### Cross-Task Learning

- **Review feedback propagation**: Issues raised during Phase C reviews are accumulated and included as "lessons learned" in subsequent Phase B prompts
- **Failure pattern accumulation**: Failure patterns from Phase A/B/verification/review are recorded to prevent repeating the same mistakes
- **Deduplication**: Similar learning entries are automatically deduplicated to prevent prompt bloat

### Execution Efficiency

- **Phase A early termination**: When enough personas have completed and file-level consensus reaches 70%+, remaining personas are skipped and synthesis proceeds
- **Phase A parallel prefetch**: Phase A (plan design) runs in parallel for tasks with no dependencies, since Phase A is read-only and safe to parallelize (default: up to 3 concurrent)
- **Parallel verification**: lint, typecheck, and test run in parallel to reduce verification time
- **Differential review**: On Phase C retry, review focuses on the diff between the previous review feedback and the current changes

## Fault Tolerance

### Phase A Retry + Fallback

Graduated recovery when personas fail to produce structured output:

1. **Auto-retry**: Failed personas are retried once (until minimum count is met)
2. **Single-plan adoption**: If only one persona succeeds, synthesis is skipped and that plan is used directly
3. **Direct plan**: If all personas fail, a plan is generated without personas

### Review Severity Filter

When Phase C review returns `changes_requested` but all issues are `info`-level (no warnings or errors), it's treated as `approved`. Prevents retry loops over trivial issues like missing `.gitkeep` files.

### No-Diff Detection

After a review fix attempt, if `git diff` shows no changes, the fix agent was unable to make effective changes — the task is approved and execution moves on. Prevents infinite retry loops.

### Smart Circuit Breaker

Phase A structured output failures (persona output format issues) are treated as soft failures and don't count toward the circuit breaker. Only substantive failures in implementation and review are counted, with a threshold of 3 consecutive failures.

### Exponential Backoff Retry

When Claude CLI calls hit rate limits, connection errors, or server errors (429/502/503/529), requests are retried with exponential backoff (3s → 6s → 12s, up to 2 retries). Prevents unnecessary failures from transient issues.

### Verification Timeout

Verification commands (lint, typecheck, test) have a configurable timeout (default: 5 minutes). Prevents the orchestrator from hanging due to infinite loops in tests. Set via `verification.timeout_seconds`.

### `--retry-failed`

`--resume --retry-failed` resets failed and blocked tasks to pending and re-executes them. Tasks blocked by upstream failures are cascadingly reset.

## Safety

- **Budget limits**: Per-persona, per-task, and total budget caps
- **Circuit breaker**: Stops after 3 consecutive task failures (Phase A output failures excluded)
- **Verification gate**: Changes aren't committed unless lint + typecheck + test pass
- **Multi-persona review gate**: After verification, 3 specialist reviewers audit correctness, security, and maintainability in parallel (any rejection triggers a fix)
- **Auto-revert**: Failed task changes are automatically rolled back
- **Resumable**: State is saved on Ctrl+C, resume with `--resume`

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
| `--dry-run` flag | Run through Phase A (planning) only, review before implementing |
| `--refine` flag | Modify task queue with natural language (repeatable) |
| Budget limits + circuit breaker | Automatic runaway prevention |

"Not knowing what's happening" is addressed by logs and terminal output. "I want to stop" is handled by Ctrl+C. If you want to change direction mid-run, stop and re-run with an updated goal — this produces better results than mid-stream intervention.

## Personas

| Persona | Focus |
|---------|-------|
| conservative | Stability, proven patterns, error handling |
| minimalist | Minimal code, eliminating unnecessary abstractions |
| tdd | Test-first design, edge case coverage |
| performance | Algorithm efficiency, bundle size, rendering |
| ux | Loading states, error messages, accessibility |
| security | Input validation, auth boundaries, XSS/CSRF |
| pragmatist | Ship working software, practical trade-offs |

Customize personas by editing `lib/personas.json`.

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

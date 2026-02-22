---
name: convergent
description: Autonomous development orchestrator using tournament-based convergent evolution. Multiple competing implementations race in parallel git worktrees, verified objectively, and the fittest survivor is selected by an AI judge.
argument-hint: --goal "goal" --context "target paths" [--review] [--resume] [--max-budget N] [--model model]
allowed-tools: Bash(convergent:*)
---

# convergent: Tournament-Based Autonomous Development

Run convergent. This tool autonomously implements code through a pipeline of Phase 0 (task generation) → Phase T (tournament) → Verify → Phase C (review).

## When Arguments Are Provided

Pass them directly to convergent.ts:

```bash
convergent $ARGUMENTS
```

## When No Arguments Are Provided

Ask the user for the following before running:

1. **--goal**: What to achieve (in natural language)
2. **--context**: Files/directories to analyze (comma-separated)
3. **--review**: Whether to pause after task generation for review (recommended)
4. **--max-budget**: Budget cap in USD (default: 50)
5. **--model**: Model to use (default: opus)

After confirmation, assemble and run the command.

## Examples

```bash
# Full autonomous run
convergent \
  --context "docs/,src/,README.md" \
  --goal "Implement JWT authentication"

# Review task queue before executing
convergent \
  --context "src/" \
  --goal "Fix all type errors" \
  --review

# Resume from interruption
convergent --resume

# With budget cap
convergent \
  --context "." \
  --goal "Add dark mode support" \
  --max-budget 20.00
```

## Notes

- Requires `bun` and `claude` CLI to be installed
- Execution logs are saved to `.convergent/logs/`
- Can be interrupted with Ctrl+C and resumed with `--resume`
- Automatically stops on budget exhaustion or 3 consecutive task failures
- Runs can take a while (proportional to task count × competitor count) — monitor progress via terminal output

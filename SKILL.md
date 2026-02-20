---
name: convergent
description: Autonomous development orchestrator using convergent evolution. Multiple AI personas independently design implementation plans, then the best elements are synthesized into an optimal plan and executed automatically.
argument-hint: --goal "goal" --context "target paths" [--review] [--resume] [--max-budget N] [--model model]
allowed-tools: Bash(convergent:*)
---

# convergent: Convergent Evolution Autonomous Development

Run convergent. This tool autonomously implements code through a pipeline of Phase 0 (task generation) → Phase A (convergent evolution) → Phase B (implementation) → Phase C (review).

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
- Runs can take a while (proportional to task count × persona count) — monitor progress via terminal output

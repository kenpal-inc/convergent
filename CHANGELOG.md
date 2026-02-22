# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-02-22

### Changed
- **BREAKING**: Replace multi-persona planning (Phase A) with tournament-based implementation (Phase T)
  - Multiple competing implementations now race in parallel git worktrees
  - Each competitor is verified objectively (typecheck, lint, tests, format)
  - AI judge selects the best implementation based on verification scores and code quality
- **BREAKING**: Remove `personas` config section (replaced by `tournament`)
- **BREAKING**: Remove `models.persona` and `models.synthesizer` config (replaced by `models.executor`)
- Verification auto-detects project tooling (tsconfig.json, lint/test scripts, prettier) by default

### Added
- Tournament engine with parallel git worktrees (`src/tournament.ts`)
- Competitor strategies: pragmatist, thorough, deconstructor (`lib/competitors.json`)
- AI judge for semantic comparison when verification scores tie
- Convergence analysis — measures file-level agreement between competitors
- Phase 0 research step — fetches GitHub issues and external references before task planning
- `verification.auto_detect` config option (default: true)
- `cwd` option for `callClaude` — enables correct project root targeting

### Fixed
- Tournament worktrees created outside project tree to prevent Claude CLI path resolution issues
- `projectRoot` correctly derived from `--context` instead of `process.cwd()`
- Sequential task pipelines no longer deadlock on intermediate verification failures
- All `callClaude` calls pass `cwd: projectRoot` for correct tool execution context

### Removed
- Phase A multi-persona planning and synthesis
- `lib/personas.json` (7 planning personas)
- `src/phaseA.ts`
- `models.persona`, `models.synthesizer` config options
- `personas` config section (trivial/standard/complex persona assignments)

## [1.0.0] - 2026-02-21

### Added
- Convergent evolution orchestration (Phase 0 → A → B → C pipeline)
- Task types: `code`, `explore`, `command` with automatic classification
- Multi-persona planning with early termination on high consensus
- Multi-persona code review (correctness, security, maintainability)
- Cross-task learning propagation (review feedback, failure patterns)
- Budget tracking with per-persona, per-task, and total caps
- State persistence and resume capability (`--resume`, `--retry-failed`)
- Git integration (auto-commit, branch creation)
- Verification gate (lint, typecheck, test) with parallel execution
- Natural language instructions (`--instructions`, `--instructions-file`)
- Review-then-refine workflow (`--review`, `--refine`)
- Dry-run mode (`--dry-run`) for plan-only generation
- Import dependency tracing for context enrichment
- Exponential backoff retry for transient API errors
- Smart circuit breaker (3 consecutive substantive failures)
- Configurable verification timeout
- curl-based installation (`install.sh`)
- CI workflow (GitHub Actions)
- Release automation (GitHub Actions, triggered on version tags)
- Full English documentation (README, CONTRIBUTING, CODE_OF_CONDUCT)
- GitHub issue and PR templates

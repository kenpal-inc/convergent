# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.5.0] - 2026-02-24

### Added
- **Auto dependency install**: Automatically runs `bun install` before verification when `package.json` exists but `node_modules` is missing — fixes the gap where worktree competitors install dependencies but the main tree doesn't
- **Requirements coverage check**: After Phase 0 generates the task queue, an AI analyst compares it against the user's instructions to detect missing requirements. If gaps are found, the task queue is automatically regenerated to include them
- **`.convergent/.gitignore`**: The `.convergent/` directory now contains its own `*` gitignore on first run, providing defense-in-depth against accidental commits

### Changed
- Landing page (EN/JA): Toned down convergent evolution claims — "optimal" → "robust", "applies this directly" → "inspired by this phenomenon"

### Fixed
- **Phase F diagnosis budget exhaustion**: Removed tools (Read/Glob/Grep) from diagnosis call — the AI was spending 16 turns reading files, exceeding $0.50 budget before producing output. Diagnosis is a pure classification task with file list + verification errors already in the prompt
- **Greenfield `git init`**: Auto-initialize git repository when no `.git` directory exists (previously assumed repo existed)

## [2.4.0] - 2026-02-24

### Added
- **Phase F**: Post-pipeline integration check — AI-powered cross-task coherence verification and auto-repair
  - Runs after all tasks complete, before summary report
  - Detects issues like missing API routes referenced by frontend, broken imports, inconsistent schemas
  - Automatically spawns a fix agent for critical issues, then re-verifies and commits
  - Non-blocking: failures don't stop the pipeline
- **`models.judge`** config option (default: `sonnet`) — separate model for judging and commit message generation
  - `judgeCompetitors` and `gitCommitTask` use the judge model (cost-effective)
  - `analyzeSemanticConvergence` stays on `models.planner` (opus) to preserve synthesis quality
- **Dynamic competitor scaling** based on task complexity
  - Phase 0 now classifies tasks more accurately: trivial (1 competitor), standard (2), complex (3)
  - Improved complexity guidance in system prompt: greenfield setup is always trivial, CRUD is standard, only genuine architectural decisions are complex

### Changed
- Phase 0 system prompt rewritten with detailed complexity classification guidance
- `estimated_complexity` schema description updated to match new guidance

## [2.3.1] - 2026-02-23

### Fixed
- **Worktree cleanup**: `removeWorktree()` now runs `git config --unset core.worktree` after removal, preventing stale worktree paths from breaking git commands

## [2.3.0] - 2026-02-23

### Fixed
- **Commit message sanitization**: `looksLikeClaudeError()` in git.ts detects Claude error messages ("Prompt is too long", etc.) and prevents them from becoming commit messages
- **Synthesis empty response**: Added `tools: ""` to `analyzeSemanticConvergence` and `judgeCompetitors` calls, fixing empty structured output
- **Greenfield `.gitignore`**: Auto-generates sensible defaults (node_modules, .next, .env, etc.) when no `.gitignore` exists, preventing accidental commits of dependency directories

## [2.2.0] - 2026-02-23

### Added
- **Bare text argument**: Running `convergent "your instructions here"` is now shorthand for `--instructions "your instructions here"`

## [2.1.0] - 2026-02-23

### Added
- **Convergence synthesis**: AI-powered semantic convergence analysis for tournament results
  - `analyzeSemanticConvergence` identifies shared design decisions across competing implementations
  - `synthesizeFromConvergence` creates optimal solutions from convergent patterns
  - `convergence_threshold` config option (default: 0.5) controls sensitivity
- Convergence synthesis types in `types.ts` with full test coverage
- Synthesis metadata recorded in task state and surfaced in reports

### Changed
- Tournament engine refactored to use convergence-based synthesis with fallback to score-based selection
- Landing page copy updated to reflect convergence-based synthesis mechanism

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

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

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

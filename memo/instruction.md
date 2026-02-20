# Instruction for AI Assistants Working on This Repository

This document provides everything you need to continue developing **convergent** as a public OSS project.

## Project Overview

**convergent** is an autonomous development orchestrator for Claude Code. It takes a codebase context and a goal, decomposes work into tasks, and uses a "convergent evolution" approach — multiple AI personas independently design solutions, then a synthesizer merges the best elements into an optimal implementation plan.

### Execution Pipeline

```
Phase 0: Task Generation
  Input: --context (files/dirs) + --goal (natural language)
  → Generates structured task queue with dependency graph
  → Assigns task types: code | explore | command

code tasks:    Phase A (convergent evolution) → Phase B (implement) → verify → Phase C (review)
explore tasks: Direct execution → findings.md (auto-propagated to dependent tasks)
command tasks: Direct execution → success/fail
```

### Key Technical Facts

- **Runtime**: Bun (>=1.0.0) — zero npm dependencies
- **Language**: TypeScript (all source in `src/`, entrypoint is `convergent.ts`)
- **External dependency**: `claude` CLI (Claude Code) must be installed
- **Tests**: `bun test` — 110 tests, all passing
- **License**: MIT
- **Owner**: kenpal-inc (GitHub org)

## Repository Structure

```
convergent/
├── convergent.ts          # Main executable (#!/usr/bin/env bun)
├── package.json           # name, version, bin field for CLI
├── README.md              # Currently in Japanese — needs English rewrite
├── SKILL.md               # Claude Code skill definition (Japanese)
├── LICENSE                 # MIT
├── .gitignore             # node_modules/, .convergent/, .DS_Store
├── src/                   # Core modules (17 files)
│   ├── claude.ts          #   Claude CLI wrapper with retry/timeout
│   ├── phase0.ts          #   Task generation
│   ├── phaseA.ts          #   Convergent evolution (multi-persona planning)
│   ├── phaseB.ts          #   Implementation execution
│   ├── phaseC.ts          #   Multi-persona code review
│   ├── git.ts             #   Git operations (commit, branch, PR)
│   ├── state.ts           #   Run state persistence
│   ├── budget.ts          #   Cost tracking with mutex
│   ├── config.ts          #   Configuration loading
│   ├── context.ts         #   Codebase context gathering
│   ├── depgraph.ts        #   Task dependency graph resolution
│   ├── learnings.ts       #   Cross-task learning propagation
│   ├── logger.ts          #   Structured logging
│   ├── reports.ts         #   Task/summary report generation
│   ├── summarize.ts       #   AI-powered summarization
│   ├── types.ts           #   Type definitions
│   └── verify.ts          #   Verification command runner
├── lib/                   # Configuration & persona definitions
│   ├── config.default.json
│   ├── personas.json      # Planning personas (pragmatist, tdd, security, etc.)
│   └── review_personas.json # Review personas
├── templates/             # JSON schemas for structured AI output
├── tests/                 # 13 test files, 110 tests total
├── test-utils/            # Test helpers
└── memo/                  # Internal documentation (not user-facing)
```

## Current State

### What's Done
- Full tool implementation (Phase 0 through Phase C)
- Task types: code, explore, command
- Budget tracking, state persistence, resume capability
- Git integration (auto-commit, branch creation, PR creation)
- Multi-pass learning between tasks
- Test suite: 110 tests passing
- MIT LICENSE, package.json with bin field
- Pushed to `kenpal-inc/convergent` on GitHub (public)

### What Needs Work

#### Priority 1: English-First OSS

The repository is public. All user-facing content must be in English so the global community can use it.

- [ ] **Rewrite README.md in English** — This is the most important task. Keep the architecture diagram but translate all text. Add: installation instructions, quick start, configuration reference, how it works section, examples
- [ ] **Rewrite SKILL.md in English** — Claude Code skill definition
- [ ] **Translate all Japanese comments in source code** — Especially in `convergent.ts` (help text, log messages). Source files in `src/` may also have Japanese comments/log messages
- [ ] **Translate config.default.json comments** (if any)
- [ ] **Add CONTRIBUTING.md** — Standard OSS contribution guide (how to build, test, submit PRs)
- [ ] **Add issue templates** — `.github/ISSUE_TEMPLATE/` for bug reports and feature requests
- [ ] **Add PR template** — `.github/PULL_REQUEST_TEMPLATE.md`
- [ ] **Add CODE_OF_CONDUCT.md** — Standard Contributor Covenant or similar

#### Priority 2: curl-Based Installation

Enable users to install via:
```bash
curl -fsSL https://raw.githubusercontent.com/kenpal-inc/convergent/main/install.sh | bash
```

What's needed:
- [ ] **Create `install.sh`** — Download script that:
  1. Checks for `bun` (required runtime)
  2. Downloads the latest release tarball from GitHub Releases
  3. Extracts to `~/.convergent/app/`
  4. Creates a wrapper script at `~/.local/bin/convergent` (or adds to PATH)
  5. Prints success message with usage hint
- [ ] **Set up GitHub Releases** — Tag versions, attach tarball of the tool
- [ ] **Create release automation** — GitHub Actions workflow to create releases on tag push
- [ ] **Version management** — Keep `package.json` version in sync with git tags

#### Priority 3: Public Repository Hygiene

- [ ] **GitHub repo description** — Set to: `Autonomous development orchestrator — multiple AI personas converge on optimal implementations via Claude Code`
- [ ] **GitHub topics** — Add: `ai`, `claude`, `autonomous-development`, `code-generation`, `developer-tools`, `bun`, `typescript`
- [ ] **Add CI workflow** — `.github/workflows/test.yml` that runs `bun test` on push/PR
- [ ] **Add badges to README** — CI status, license, Bun version
- [ ] **Create CHANGELOG.md** — Track changes per version
- [ ] **Add `.github/FUNDING.yml`** if applicable

## Development Commands

```bash
# Run all tests
bun test

# Run specific test file
bun test tests/reports.test.ts

# Run the tool itself (from any project directory)
bun run /path/to/convergent/convergent.ts --help
```

## Known Issues & Decisions

### Bun Test Isolation
Bun's test runner has issues with global mock isolation (`Bun.spawn` mocking leaks across parallel test files). Tests that relied on `Bun.spawn` mocking (`claude-timeout.test.ts`, `git-commit.test.ts`) were removed rather than maintained as flaky. The `isTransientError` bug those tests exposed has been fixed in source.

### child_process.spawn in Bun
Some functions in `src/git.ts` use `child_process.spawn` (imported at the top) alongside `Bun.spawn`. The `child_process.spawn` calls trigger `ptr.updateRef` errors in Bun 1.3.6's test runner. This doesn't affect production usage — only test mocking.

### ReadableStream Pattern
The `new Response(proc.stdout).text()` pattern used in `src/git.ts` and `src/reports.ts` can hang in Bun's test context when stdout pipes aren't consumed. Production usage is unaffected. Test setup uses `Bun.spawnSync` with `stdout: 'ignore'` as workaround.

### README is in Japanese
The current README.md and SKILL.md are entirely in Japanese. These were written during internal development. Rewriting in English is the top priority for OSS readiness.

### Log Messages
Console output and log messages in `convergent.ts` and `src/logger.ts` are a mix of English and Japanese. These should be standardized to English.

## Style Guidelines

- **Language**: All code, comments, commit messages, and documentation should be in English
- **Formatting**: No specific linter configured yet (potential future task)
- **Commit messages**: Use conventional style — concise, imperative, explain "why" not "what"
- **No npm dependencies**: The tool intentionally has zero npm deps. Keep it that way unless absolutely necessary
- **Bun-native**: Use Bun APIs (`Bun.spawn`, `Bun.file`, `Bun.write`) over Node.js equivalents where possible

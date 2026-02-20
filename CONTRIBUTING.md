# Contributing to convergent

Thank you for your interest in contributing! This guide will help you get started.

## Prerequisites

- [Bun](https://bun.sh/) (>=1.0.0)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude` command) — needed for integration testing
- Git

## Setup

```bash
git clone https://github.com/kenpal-inc/convergent.git
cd convergent
```

No `npm install` or `bun install` needed — the project has zero npm dependencies.

## Development

```bash
# Run all tests
bun test

# Run a specific test file
bun test tests/reports.test.ts

# Run the tool (from any project directory)
bun run /path/to/convergent/convergent.ts --help
```

## Project Structure

```
convergent.ts          # Main executable entry point
src/                   # Core modules
├── phase0.ts          #   Task generation
├── phaseA.ts          #   Convergent evolution (multi-persona planning)
├── phaseB.ts          #   Implementation execution
├── phaseC.ts          #   Multi-persona code review
├── claude.ts          #   Claude CLI wrapper with retry/timeout
├── git.ts             #   Git operations
├── state.ts           #   Run state persistence
├── budget.ts          #   Cost tracking
├── config.ts          #   Configuration loading
├── context.ts         #   Codebase context gathering
├── depgraph.ts        #   Task dependency resolution
├── learnings.ts       #   Cross-task learning propagation
├── logger.ts          #   Structured logging
├── reports.ts         #   Report generation
├── summarize.ts       #   AI-powered summarization
├── types.ts           #   Type definitions
└── verify.ts          #   Verification command runner
lib/                   # Configuration & persona definitions
templates/             # JSON schemas for structured AI output
tests/                 # Test suite
test-utils/            # Test helpers
```

## Guidelines

- **No npm dependencies.** The project intentionally has zero npm deps. Keep it that way unless absolutely necessary.
- **Bun-native.** Use Bun APIs (`Bun.spawn`, `Bun.file`, `Bun.write`) over Node.js equivalents where possible.
- **English only.** All code, comments, commit messages, and documentation must be in English.
- **Commit messages.** Use conventional style — concise, imperative mood, explain "why" not "what".

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b my-feature`)
3. Make your changes
4. Run tests (`bun test`) and ensure they pass
5. Commit with a clear message
6. Push to your fork and open a Pull Request

## Reporting Issues

- Use the [Bug Report](https://github.com/kenpal-inc/convergent/issues/new?template=bug_report.md) template for bugs
- Use the [Feature Request](https://github.com/kenpal-inc/convergent/issues/new?template=feature_request.md) template for ideas

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

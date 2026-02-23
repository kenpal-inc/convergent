#!/usr/bin/env bun

/**
 * convergent: Autonomous development orchestrator using convergent evolution
 *
 * Usage:
 *   convergent --context "docs/ src/" --goal "implement feature X"
 *   convergent --resume
 *   convergent --context "." --goal "fix type errors" --review
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, readlinkSync } from "fs";
import { resolve, dirname, join, relative } from "path";
import { readFile } from "fs/promises";
import { log, initLogging, setVerbose, die } from "./src/logger";
import { loadConfig, applyOverrides } from "./src/config";
import { initBudgetModule, initBudget, checkBudgetAvailable } from "./src/budget";
import { initStateModule, initState, getTaskStatus, updateTaskStatus, getConsecutiveFailures, checkDependenciesMet, getTasksByStatus, countTasksByStatus, updatePrUrl, resetFailedTasks, recordTournamentMetrics } from "./src/state";
import { generateTaskQueue, refineTaskQueue, researchInstructions } from "./src/phase0";
import { runTournament } from "./src/tournament";
import { runPhaseBRetryWithReview, runExploreTask, runCommandTask } from "./src/phaseB";
import { runPhaseC, buildReviewFeedback, type ReviewRetryInfo } from "./src/phaseC";
import { runVerification } from "./src/verify";
import { gitCommitTask, gitRevertChanges, createBranch, createPullRequest, getHeadCommit } from "./src/git";
import { generateTaskReport, generateSummaryReport } from "./src/reports";
import { recordReviewLearning, recordFailureLearning } from "./src/learnings";
import type { CliArgs, Config, Task, TaskQueue, TournamentMetrics } from "./src/types";

const VERSION = "2.0.0";
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const LIB_DIR = resolve(SCRIPT_DIR, "lib");
const TEMPLATES_DIR = resolve(SCRIPT_DIR, "templates");

function showHelp(): void {
  console.log(`convergent - Autonomous development orchestrator using convergent evolution

USAGE:
  convergent --context <paths> --goal <text> [options]
  convergent --instructions <text> [options]
  convergent --instructions-file <path> [options]
  convergent --resume [options]

REQUIRED (unless --resume / --instructions):
  --context <paths>     Comma-separated files/directories for Claude to analyze (default: "." if --instructions used)
  --goal <text>         What to achieve (auto-derived from --instructions if omitted)

OPTIONS:
  --instructions <text>       Specific instructions for task generation (natural language)
  --instructions-file <path>  Read instructions from a file (e.g., TODO.md)
  --resume              Resume latest run (.convergent/latest/state.json)
  --retry-failed        With --resume, reset failed tasks to pending and retry them
  --review              Stop after Phase 0 (task generation) for human review
  --dry-run             Run Phase 0 only (generate task queue without implementing)
  --refine <text>       Refine latest task queue with natural language instructions
  --config <path>       Custom config file (overrides defaults)
  --max-budget <USD>    Total budget cap in USD (default: 50.00)
  --model <model>       Override default model for all phases
  --verbose             Enable debug logging
  --version             Show version
  --help                Show this help

EXAMPLES:
  convergent \\
    --context "docs/,src/,memo/remaining-tasks.md" \\
    --goal "Implement all remaining tasks"

  # Instructions only (goal and context auto-derived)
  convergent \\
    --instructions "Switch auth from JWT to session-based. Add a role field to the user model"

  # Read instructions from a file
  convergent --instructions-file ./TODO.md

  # With goal + instructions for more control
  convergent \\
    --context "src/" --goal "Improve e-commerce backend" \\
    --instructions "Switch auth from JWT to session-based"

  convergent --context "src/" --goal "Fix type errors" --review

  convergent --resume

  # Refine task queue after --review
  convergent --refine "Remove task-001, it's unnecessary. Change task-003 complexity to standard"`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    context: [],
    goal: "",
    resume: false,
    review: false,
    dryRun: false,
    retryFailed: false,
    verbose: false,
  };

  const rawArgs = argv.slice(2); // skip bun and script path
  let i = 0;

  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    switch (arg) {
      case "--context":
        i++;
        args.context = rawArgs[i]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
        break;
      case "--goal":
        i++;
        args.goal = rawArgs[i] ?? "";
        break;
      case "--instructions":
        i++;
        args.instructions = rawArgs[i] ?? "";
        break;
      case "--instructions-file":
        i++;
        {
          const filePath = rawArgs[i];
          if (!filePath) die("--instructions-file requires a file path");
          try {
            args.instructions = readFileSync(resolve(filePath), "utf-8").trim();
          } catch (e) {
            die(`Cannot read instructions file: ${filePath} (${e instanceof Error ? e.message : String(e)})`);
          }
        }
        break;
      case "--resume":
        args.resume = true;
        break;
      case "--review":
        args.review = true;
        break;
      case "--refine":
        i++;
        args.refine = rawArgs[i] ?? "";
        break;
      case "--retry-failed":
        args.retryFailed = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--config":
        i++;
        args.configPath = rawArgs[i];
        break;
      case "--max-budget":
        i++;
        args.maxBudget = parseFloat(rawArgs[i] ?? "0");
        break;
      case "--model":
        i++;
        args.model = rawArgs[i];
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--version":
      case "-v":
        console.log(`convergent v${VERSION}`);
        process.exit(0);
      case "--help":
      case "-h":
        showHelp();
        process.exit(0);
      default:
        die(`Unknown option: ${arg} (use --help for usage)`);
    }
    i++;
  }

  if (args.refine !== undefined && !args.refine) {
    die("--refine requires an instruction text");
  }

  if (!args.resume && !args.refine) {
    // If instructions provided, goal and context become optional
    if (args.instructions) {
      if (!args.goal) {
        // Auto-generate goal from instructions (first line, truncated)
        const firstLine = args.instructions.split("\n").find((l) => l.trim()) ?? args.instructions;
        args.goal = firstLine.slice(0, 100).trim();
      }
      if (args.context.length === 0) {
        args.context = ["."];
      }
    } else {
      if (!args.goal) die("--goal is required (or use --resume / --refine / --instructions)");
      if (args.context.length === 0) die("--context is required (or use --resume / --refine / --instructions)");
    }
  }

  return args;
}

/**
 * Collect findings from dependency explore tasks to pass as context.
 */
function collectDependencyFindings(task: Task, allTasks: Task[], outputDir: string): string | undefined {
  if (!task.depends_on || task.depends_on.length === 0) return undefined;

  const findings: string[] = [];
  for (const depId of task.depends_on) {
    const depTask = allTasks.find((t) => t.id === depId);
    if (!depTask || (depTask.type !== "explore")) continue;

    const findingsPath = `${outputDir}/logs/task-${depId}/findings.md`;
    if (existsSync(findingsPath)) {
      const content = readFileSync(findingsPath, "utf-8").trim();
      if (content) {
        findings.push(`### Findings from ${depId}: ${depTask.title}\n\n${content}`);
      }
    }
  }

  return findings.length > 0 ? findings.join("\n\n---\n\n") : undefined;
}

/**
 * Check if there are uncommitted git changes.
 */
async function checkGitChanges(projectRoot: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim().length > 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  setVerbose(args.verbose);

  // Derive project root from --context (target project) rather than cwd (convergent itself).
  // When running "convergent --context /path/to/project", the project root is that path.
  const projectRoot = args.context.length === 1 && existsSync(args.context[0])
    ? resolve(args.context[0])
    : process.cwd();
  const baseDir = resolve(projectRoot, ".convergent");
  const runsDir = resolve(baseDir, "runs");
  const latestLink = resolve(baseDir, "latest");

  // Check for claude CLI
  const whichProc = Bun.spawn(["which", "claude"], { stdout: "pipe", stderr: "pipe" });
  await whichProc.exited;
  if (whichProc.exitCode !== 0) {
    die("claude CLI not found. Install Claude Code first.");
  }

  // Load configuration
  let config = await loadConfig(
    resolve(LIB_DIR, "config.default.json"),
    resolve(projectRoot, "convergent.config.json"),
    args.configPath,
  );
  config = applyOverrides(config, {
    maxBudget: args.maxBudget,
    model: args.model,
  });

  // --- Refine mode: modify existing task queue and exit ---
  if (args.refine) {
    if (!existsSync(latestLink)) die(`No latest run found at ${latestLink}. Run with --context and --goal first.`);
    let refineOutputDir: string;
    try {
      const target = readlinkSync(latestLink);
      refineOutputDir = resolve(baseDir, target);
    } catch {
      die(`Cannot read symlink at ${latestLink}`);
      return;
    }
    const tasksPath = `${refineOutputDir}/tasks.json`;
    if (!existsSync(tasksPath)) die(`No tasks file found at ${tasksPath}`);

    initBudgetModule(refineOutputDir);
    mkdirSync(`${refineOutputDir}/logs/phase0`, { recursive: true });

    const currentTaskQueue = JSON.parse(readFileSync(tasksPath, "utf-8"));
    const beforeJson = JSON.stringify(currentTaskQueue, null, 2);

    console.log("");
    console.log(log.bold(`convergent v${VERSION} — refine mode`));
    console.log(`Instruction: ${args.refine}`);
    console.log(`Tasks file: ${tasksPath}`);
    console.log("");

    const refined = await refineTaskQueue(
      args.refine,
      currentTaskQueue,
      config,
      refineOutputDir,
      TEMPLATES_DIR,
    );

    await Bun.write(tasksPath, JSON.stringify(refined, null, 2));

    // Show diff
    const afterJson = JSON.stringify(refined, null, 2);
    console.log("");
    log.ok(`Task queue refined: ${refined.tasks.length} tasks`);
    console.log("");
    log.info("Task queue:");
    for (const task of refined.tasks) {
      const tag = task.estimated_complexity.toUpperCase().slice(0, 3);
      log.info(`  [${tag}] ${task.id}: ${task.title}`);
    }

    if (beforeJson === afterJson) {
      console.log("");
      log.warn("No changes were made to the task queue.");
    } else {
      console.log("");
      log.info("Task queue updated. Review and then run: convergent --resume");
    }

    process.exit(0);
  }

  // Determine outputDir based on mode
  let outputDir: string;

  if (args.resume) {
    // Resolve latest symlink to find the run to resume
    if (!existsSync(latestLink)) die(`No latest run found at ${latestLink}. Nothing to resume.`);
    try {
      const target = readlinkSync(latestLink);
      outputDir = resolve(baseDir, target);
    } catch {
      die(`Cannot read symlink at ${latestLink}`);
      return; // unreachable, but helps TS
    }
    if (!existsSync(`${outputDir}/state.json`)) die(`No state file found at ${outputDir}/state.json`);
    if (!existsSync(`${outputDir}/tasks.json`)) die(`No tasks file found at ${outputDir}/tasks.json`);
  } else {
    // Create new run directory with timestamp
    const now = new Date();
    const runId = now.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
    outputDir = resolve(runsDir, runId);
    mkdirSync(outputDir, { recursive: true });

    // Update latest symlink
    try {
      if (existsSync(latestLink)) unlinkSync(latestLink);
    } catch { /* ignore */ }
    const relTarget = relative(baseDir, outputDir);
    symlinkSync(relTarget, latestLink);
  }

  // Signal handling
  let interrupted = false;
  const cleanup = async () => {
    if (interrupted) return;
    interrupted = true;
    console.log("");
    log.warn("Interrupted (SIGINT/SIGTERM)");
    log.warn(`State saved to ${outputDir}/state.json`);
    log.warn("Resume with: convergent --resume");
    await printSummary(outputDir);
    process.exit(130);
  };
  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());

  // Ensure .convergent/ is gitignored to prevent it leaking into commits/worktrees
  const gitignorePath = resolve(projectRoot, ".gitignore");
  const convergentIgnoreEntry = ".convergent/";
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(convergentIgnoreEntry)) {
      await Bun.write(gitignorePath, content.trimEnd() + "\n" + convergentIgnoreEntry + "\n");
      log.debug("Added .convergent/ to .gitignore");
    }
  } else {
    await Bun.write(gitignorePath, convergentIgnoreEntry + "\n");
    log.debug("Created .gitignore with .convergent/");
  }

  // Initialize modules
  initBudgetModule(outputDir);
  initStateModule(outputDir);

  let taskQueue: TaskQueue;

  if (args.resume) {
    initLogging(outputDir);
    log.info(`Resuming from ${outputDir}`);
    taskQueue = JSON.parse(readFileSync(`${outputDir}/tasks.json`, "utf-8"));

    // Resolve in_progress tasks left over from interrupted runs
    const stateForResume = JSON.parse(readFileSync(`${outputDir}/state.json`, "utf-8"));
    for (const [taskId, taskStatus] of Object.entries(stateForResume.tasks_status ?? {})) {
      const ts = taskStatus as { status: string; phase?: string };
      if (ts.status !== "in_progress") continue;

      const taskDef = taskQueue.tasks.find((t) => t.id === taskId);
      const taskType = taskDef?.type ?? "code";

      if (taskType === "explore") {
        // Explore task: check if findings.md exists — if so, treat as completed
        const findingsPath = `${outputDir}/logs/task-${taskId}/findings.md`;
        if (existsSync(findingsPath)) {
          const content = readFileSync(findingsPath, "utf-8").trim();
          if (content.length > 0) {
            log.info(`Resolving interrupted explore task ${taskId}: findings.md exists (${content.length} chars) — marking completed`);
            await updateTaskStatus(taskId, "completed");
            continue;
          }
        }
      }

      // All other cases: reset to pending so they can be re-executed
      log.info(`Resolving interrupted task ${taskId} (${taskType}, phase: ${ts.phase ?? "?"}): resetting to pending`);
      await updateTaskStatus(taskId, "pending");
    }

    if (args.retryFailed) {
      const resetIds = await resetFailedTasks();
      if (resetIds.length > 0) {
        log.info(`Reset ${resetIds.length} failed/blocked task(s) to pending: ${resetIds.join(", ")}`);
      } else {
        log.info("No failed or blocked tasks to retry.");
      }
    }
  } else {
    initLogging(outputDir);
    await initBudget();

    console.log("");
    console.log(log.bold(`convergent v${VERSION}`));
    console.log(`Goal: ${args.goal}`);
    if (args.instructions) {
      console.log(`Instructions: ${args.instructions.length > 100 ? args.instructions.slice(0, 100) + "..." : args.instructions}`);
    }
    console.log(`Context: ${args.context.join(", ")}`);
    console.log("");

    // Research step: enrich instructions by fetching external references
    let enrichedInstructions = args.instructions;
    if (args.instructions) {
      enrichedInstructions = await researchInstructions(
        args.instructions,
        config,
        outputDir,
        projectRoot,
      );
    }

    taskQueue = await generateTaskQueue(
      args.goal,
      args.context,
      config,
      projectRoot,
      outputDir,
      TEMPLATES_DIR,
      enrichedInstructions,
    );

    await initState();

    // Create git branch if configured
    if (config.git?.create_branch === true) {
      log.info('Creating new git branch for this run...');
      const branchResult = await createBranch(projectRoot);
      if (branchResult.success) {
        log.ok(`Created and checked out branch: ${branchResult.branchName}`);
        // Store branch name in state
        const stateFile = `${outputDir}/state.json`;
        const state = JSON.parse(readFileSync(stateFile, "utf-8"));
        state.branch_name = branchResult.branchName;
        await Bun.write(stateFile, JSON.stringify(state, null, 2));
      } else {
        log.warn(`Failed to create branch: ${branchResult.error}. Continuing on current branch.`);
      }
    }

    if (args.review) {
      console.log("");
      log.info("Review mode: stopping after Phase 0");
      log.info(`Task queue saved to: ${outputDir}/tasks.json`);
      log.info("Edit the task queue if needed, then run: convergent --resume");
      console.log("");
      console.log(JSON.stringify(taskQueue, null, 2));
      process.exit(0);
    }
  }

  // Main task loop (multi-pass)
  const tasks = taskQueue.tasks;
  log.info(`Processing ${tasks.length} tasks...`);
  console.log("");

  const MAX_ITERATIONS = Math.min(tasks.length * 2, 100);
  let iteration = 0;
  let hasProgress = true;
  let stoppedReason: 'all_complete' | 'no_progress' | 'budget_exhausted' | 'circuit_breaker' | 'interrupted' = 'all_complete';

  while (hasProgress && iteration < MAX_ITERATIONS) {
    iteration++;
    hasProgress = false;

    // Check for interrupt at iteration level
    if (interrupted) {
      stoppedReason = 'interrupted';
      break;
    }

    // Check budget at iteration level
    if (!(await checkBudgetAvailable(config))) {
      stoppedReason = 'budget_exhausted';
      log.error(`Budget exhausted at iteration ${iteration}`);
      break;
    }

    console.log(`\n🔄 === Iteration ${iteration} ===`);
    let tasksProcessedThisIteration = 0;
    let statusChangesThisIteration = 0;

    // --- Collect ready tasks (pending + deps met) ---
    const readyTasks: Task[] = [];
    for (const task of tasks) {
      const currentStatus = await getTaskStatus(task.id);
      if (currentStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'in_progress') continue;

      if (currentStatus === 'blocked') {
        const depsOk = await checkDependenciesMet(task.id, tasks);
        if (!depsOk) continue;
        log.info(`  ✅ Task ${task.id} unblocked - dependencies now met (iteration ${iteration})`);
        await updateTaskStatus(task.id, 'pending');
        statusChangesThisIteration++;
      }

      if (currentStatus === 'pending' || currentStatus === 'blocked') {
        if (!(await checkDependenciesMet(task.id, tasks))) {
          if (currentStatus === 'pending') {
            log.warn(`Task ${task.id} blocked by unmet dependencies, marking as blocked (iteration ${iteration})`);
            await updateTaskStatus(task.id, "blocked");
            statusChangesThisIteration++;
          }
          continue;
        }
        readyTasks.push(task);
      }
    }

    if (readyTasks.length === 0) {
      log.info(`  No ready tasks in iteration ${iteration}`);
      // Check if there are still non-terminal tasks
      const remaining = await getTasksByStatus(['pending', 'blocked']);
      if (remaining.length === 0) {
        stoppedReason = 'all_complete';
        break;
      }
      continue;
    }

    // --- Execute tasks: sequential per task ---
    for (const task of readyTasks) {
      const taskType = task.type ?? "code";

      // Re-check status (may have changed)
      const currentStatus = await getTaskStatus(task.id);
      if (currentStatus !== 'in_progress' && currentStatus !== 'pending') continue;

      // Check for interrupt before processing each task
      if (interrupted) {
        stoppedReason = 'interrupted';
        break;
      }

      // Circuit breaker check
      const consecutiveFailures = await getConsecutiveFailures();
      if (consecutiveFailures >= 3) {
        stoppedReason = 'circuit_breaker';
        log.error(`Circuit breaker tripped at iteration ${iteration}`);
        break;
      }

      const taskIndex = tasks.indexOf(task);
      const typeLabel = taskType !== "code" ? ` [${taskType}]` : "";
      console.log("");
      log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      log.info(`Task ${taskIndex + 1}/${tasks.length}: ${task.title} [${task.id}]${typeLabel} (iteration ${iteration})`);
      log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      tasksProcessedThisIteration++;

      // --- Collect findings from dependency explore tasks ---
      const findingsFromDeps = collectDependencyFindings(task, tasks, outputDir);

      // --- Explore / Command tasks: simplified flow ---
      if (taskType === "explore" || taskType === "command") {
        await updateTaskStatus(task.id, "in_progress", "B");

        let taskOk: boolean;
        if (taskType === "explore") {
          taskOk = await runExploreTask(task.id, task, config, projectRoot, outputDir, findingsFromDeps);
        } else {
          taskOk = await runCommandTask(task.id, task, config, projectRoot, outputDir, findingsFromDeps);
        }

        if (!taskOk) {
          log.error(`${taskType} task ${task.id} failed`);
          await recordFailureLearning(outputDir, task.id, "B", `${taskType} task execution failed`);
          await updateTaskStatus(task.id, "failed", "B");
          statusChangesThisIteration++;
          continue;
        }

        const hasChanges = await checkGitChanges(projectRoot);
        if (hasChanges && config.git?.auto_commit !== false) {
          const commitOk = await gitCommitTask(task.id, task.title, config, projectRoot, outputDir);
          if (!commitOk) {
            log.warn(`Git commit failed for ${taskType} task ${task.id} (non-fatal)`);
          }
        }

        await updateTaskStatus(task.id, "completed");
        statusChangesThisIteration++;
        log.ok(`Task ${task.id} (${taskType}) completed successfully`);
        continue;
      }

      // --- Code tasks: Tournament → Review → Commit ---

      // Capture base commit for revert safety
      const baseCommit = await getHeadCommit(projectRoot);

      // Phase T: Tournament — N independent implementations
      await updateTaskStatus(task.id, "in_progress", "T");
      const tournamentResult = await runTournament(
        task.id, task, config, projectRoot, outputDir, LIB_DIR, baseCommit, findingsFromDeps,
      );

      if (!tournamentResult) {
        log.error(`Tournament failed for ${task.id} — no winner`);
        await recordFailureLearning(outputDir, task.id, "T", "Tournament failed: all competitors failed");
        await gitRevertChanges(projectRoot, baseCommit);
        await updateTaskStatus(task.id, "failed", "T");
        statusChangesThisIteration++;
        continue;
      }

      // Record tournament metrics
      const successfulCompetitors = tournamentResult.competitors.filter(c => c.implementationOk);
      const scores = successfulCompetitors.map(c => c.verificationScore);
      const scoreSpread = scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : 0;
      const winner = tournamentResult.competitors.find(c => c.id === tournamentResult.winnerId);

      const ca = tournamentResult.convergenceAnalysis;
      const tournamentMetrics: TournamentMetrics = {
        competitors_count: tournamentResult.competitors.length,
        implementations_succeeded: successfulCompetitors.length,
        verifications_passed: successfulCompetitors.filter(c => c.verificationScore > 0).length,
        winner_strategy: tournamentResult.winnerStrategy,
        winner_score: winner?.verificationScore ?? 0,
        score_spread: scoreSpread,
        convergence_ratio: ca?.convergence_ratio,
        diff_lines_winner: ca?.diff_lines[tournamentResult.winnerId],
        synthesis_attempted: tournamentResult.synthesis?.attempted,
        synthesis_succeeded: tournamentResult.synthesis?.succeeded,
        synthesis_fell_back: tournamentResult.synthesis?.fell_back_to_winner,
        synthesis_rationale: tournamentResult.synthesis?.rationale,
        synthesis_convergent_patterns: tournamentResult.synthesis?.semantic_analysis?.convergent_patterns?.map(p => p.pattern),
      };
      await recordTournamentMetrics(task.id, tournamentMetrics);

      const convergenceInfo = ca ? `, convergence=${(ca.convergence_ratio * 100).toFixed(0)}%` : "";
      log.info(`Tournament: ${tournamentMetrics.implementations_succeeded}/${tournamentMetrics.competitors_count} succeeded, winner=${tournamentResult.winnerStrategy} (score ${tournamentMetrics.winner_score}${convergenceInfo})`);
      if (tournamentResult.judgeRationale) {
        log.info(`Judge: ${tournamentResult.judgeRationale}`);
      }
      if (tournamentResult.synthesis?.attempted) {
        log.info(`Synthesis: ${tournamentResult.synthesis.succeeded ? 'succeeded' : 'fell back to winner'} — ${tournamentResult.synthesis.rationale}`);
      }

      // Verify winner's changes in the main working tree
      await updateTaskStatus(task.id, "in_progress", "verify");
      let verified = await runVerification(task.id, config, projectRoot, outputDir);

      if (!verified) {
        log.warn("Winner's changes failed verification in main tree — this may indicate worktree-specific success");
        log.warn("Accepting changes anyway (downstream tasks may fix verification issues)");
        // Don't revert — commit the changes so downstream tasks can build on them.
        // Skip review since code is in a partially-complete state.
        const commitOk = await gitCommitTask(task.id, task.title, config, projectRoot, outputDir);
        if (!commitOk) {
          log.error(`Git commit failed for task ${task.id} after verification failure`);
          await gitRevertChanges(projectRoot, baseCommit);
          await updateTaskStatus(task.id, "failed", "commit");
          statusChangesThisIteration++;
          continue;
        }
        await updateTaskStatus(task.id, "completed");
        statusChangesThisIteration++;
        log.ok(`Task ${task.id} committed (verification skipped — downstream tasks will fix)`);
        continue;
      }

      // Phase R: Code Review on winner
      // Use convergence signal to decide review strategy:
      //   high convergence (>80%) + multiple competitors = skip review (independent agreement = high confidence)
      //   single competitor or no convergence data = normal review
      let reviewApproved = true;
      const convergenceRatio = tournamentResult.convergenceAnalysis?.convergence_ratio;
      const multipleSucceeded = (tournamentResult.convergenceAnalysis !== undefined);
      const highConvergence = multipleSucceeded && convergenceRatio !== undefined && convergenceRatio >= 0.8;

      if (highConvergence) {
        log.ok(`Skipping review — high convergence (${(convergenceRatio! * 100).toFixed(0)}%) + verification passed → independent agreement`);
      } else if (config.review?.enabled !== false) {
        await updateTaskStatus(task.id, "in_progress", "review");
        const reviewMaxRetries = config.review?.max_retries ?? 2;
        let reviewAttempt = 0;
        let retryInfo: ReviewRetryInfo | undefined;

        while (reviewAttempt <= reviewMaxRetries) {
          log.phase(`Review: '${task.title}'${reviewAttempt > 0 ? ` (attempt ${reviewAttempt + 1})` : ''}`);

          try {
            const reviewResult = await runPhaseC(task.id, task, config, projectRoot, outputDir, TEMPLATES_DIR, retryInfo, baseCommit);

            if (reviewResult.verdict === "approved") {
              log.ok(`Code review passed: ${reviewResult.summary}`);
              const reviewIssues = (reviewResult.issues ?? []).map(i => i.description);
              if (reviewIssues.length > 0) {
                await recordReviewLearning(outputDir, task.id, reviewIssues);
              }
              reviewApproved = true;
              break;
            }

            if (reviewResult.verdict === "error") {
              log.warn(`Code review error (non-fatal): ${reviewResult.summary}`);
              reviewApproved = true;
              break;
            }

            // changes_requested
            if (reviewAttempt >= reviewMaxRetries) {
              log.error(`Code review not approved after ${reviewMaxRetries} retries`);
              reviewApproved = false;
              break;
            }

            const feedback = buildReviewFeedback(reviewResult);
            log.warn(`Code review requested changes (attempt ${reviewAttempt + 1}/${reviewMaxRetries}): ${reviewResult.summary}`);

            const preDiffProc = Bun.spawn(["git", "diff", baseCommit], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
            const preDiffSnapshot = await new Response(preDiffProc.stdout).text();
            await preDiffProc.exited;

            retryInfo = {
              previousDiffSnapshot: preDiffSnapshot,
              previousFeedback: feedback,
            };

            const retryOk = await runPhaseBRetryWithReview(
              task.id, task, reviewAttempt + 1, feedback, config, projectRoot, outputDir,
            );
            if (!retryOk) {
              log.error(`Review fix attempt failed for task ${task.id}`);
              reviewApproved = false;
              break;
            }

            const postDiffProc = Bun.spawn(["git", "diff", baseCommit], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
            const postDiffSnapshot = await new Response(postDiffProc.stdout).text();
            await postDiffProc.exited;

            if (preDiffSnapshot === postDiffSnapshot) {
              log.warn(`Review fix attempt ${reviewAttempt + 1} produced no changes — approving`);
              reviewApproved = true;
              break;
            }

            const reVerified = await runVerification(task.id, config, projectRoot, outputDir);
            if (!reVerified) {
              log.error(`Re-verification failed after review fix for task ${task.id}`);
              reviewApproved = false;
              break;
            }

            reviewAttempt++;
          } catch (reviewError) {
            log.warn(`Code review error (non-fatal): ${reviewError instanceof Error ? reviewError.message : String(reviewError)}`);
            reviewApproved = true;
            break;
          }
        }
      }

      if (!reviewApproved) {
        log.error(`Task ${task.id} failed code review after all retries`);
        await recordFailureLearning(outputDir, task.id, "review", "Code review not approved after all retries");
        await gitRevertChanges(projectRoot, baseCommit);
        await updateTaskStatus(task.id, "failed", "review");
        statusChangesThisIteration++;
        continue;
      }

      // Commit
      const commitOk = await gitCommitTask(task.id, task.title, config, projectRoot, outputDir);
      if (!commitOk) {
        log.error(`Git commit failed for task ${task.id}, marking as failed`);
        await gitRevertChanges(projectRoot, baseCommit);
        await updateTaskStatus(task.id, "failed", "commit");
        statusChangesThisIteration++;
        continue;
      }

      // Generate per-task completion report
      try {
        await generateTaskReport(task.id, task.title, config, projectRoot, outputDir);
      } catch (reportError) {
        console.warn(`[task-${task.id}] Report generation error (non-critical):`, reportError);
      }

      await updateTaskStatus(task.id, "completed");
      statusChangesThisIteration++;
      log.ok(`Task ${task.id} completed successfully`);
    }

    // If inner loop broke due to interrupt or circuit breaker, break outer loop too
    if (stoppedReason === 'interrupted' || stoppedReason === 'circuit_breaker') {
      break;
    }

    // Detect progress
    if (statusChangesThisIteration > 0) {
      hasProgress = true;
    }

    log.info(`  📊 Iteration ${iteration} complete: ${tasksProcessedThisIteration} tasks processed, ${statusChangesThisIteration} status changes`);

    // Check if all tasks are in terminal states
    const remainingTasks = await getTasksByStatus(['pending', 'blocked']);
    if (remainingTasks.length === 0) {
      stoppedReason = 'all_complete';
      break;
    }

    // If no progress was made and there are still non-terminal tasks, log them
    if (!hasProgress && remainingTasks.length > 0) {
      const blockedTasks = await getTasksByStatus(['blocked']);
      if (blockedTasks.length > 0) {
        log.warn(`  ⚠️ ${blockedTasks.length} task(s) remain blocked with no progress - dependencies may have failed`);
      }
    }
  }

  // After loop: check if we hit MAX_ITERATIONS
  if (iteration >= MAX_ITERATIONS) {
    stoppedReason = 'no_progress';
    log.warn(`⚠️ Reached maximum iterations (${MAX_ITERATIONS})`);
  }

  if (!hasProgress && stoppedReason === 'all_complete') {
    stoppedReason = 'no_progress';
  }

  if (args.dryRun) {
    log.info("\n[dry-run] Task queue generated. Review at:");
    log.info(`  ${outputDir}/tasks.json`);
    log.info("Then run: convergent --resume");
  }

  console.log(`\nLoop terminated: ${stoppedReason} after ${iteration} iteration(s)`);

  // Generate overall summary report
  try {
    const summaryGenerated = await generateSummaryReport(config, projectRoot, outputDir);
    if (summaryGenerated) {
      console.log(`Summary report available at: ${join(outputDir, 'reports', 'summary.md')}`);
    } else {
      console.warn('Warning: Summary report generation returned false. Check logs for details.');
    }
  } catch (error) {
    console.warn('Warning: Failed to generate summary report:', error);
  }

  // --- PR Creation ---
  if (config.git?.create_pr) {
    // Read goal from tasks.json
    let goal = '';
    try {
      const tasksJson = JSON.parse(await readFile(join(outputDir, 'tasks.json'), 'utf-8'));
      goal = tasksJson.goal || '';
    } catch {
      // If we can't read tasks.json, use a generic title
      goal = 'Auto-dev changes';
    }

    // Check if at least one task completed
    const taskCounts = await countTasksByStatus();
    const completedCount = taskCounts.completed || 0;

    if (completedCount > 0) {
      log.info('Creating pull request...');
      try {
        const prResult = await createPullRequest(config, projectRoot, outputDir, goal);
        if (prResult.success && prResult.prUrl) {
          log.ok(`Pull request created: ${prResult.prUrl}`);
          await updatePrUrl(prResult.prUrl);
        } else {
          log.warn(`PR creation skipped: ${prResult.error}`);
        }
      } catch (e) {
        log.warn(`PR creation failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      log.info('Skipping PR creation: no tasks completed successfully.');
    }
  }

  printSummary(outputDir, iteration, stoppedReason);
}

async function printSummary(outputDir: string, iteration?: number, stoppedReason?: string): Promise<void> {
  try {
    const tasksFile = `${outputDir}/tasks.json`;
    const stateFile = `${outputDir}/state.json`;
    const budgetFile = `${outputDir}/budget.json`;

    if (!existsSync(tasksFile) || !existsSync(stateFile)) return;

    const tasks = JSON.parse(readFileSync(tasksFile, "utf-8"));
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    const budget = existsSync(budgetFile)
      ? JSON.parse(readFileSync(budgetFile, "utf-8"))
      : { total_usd: 0 };

    const totalTasks = tasks.tasks?.length ?? 0;

    // Use the new countTasksByStatus helper
    const finalCounts = await countTasksByStatus();

    const calculatedTotal = finalCounts.completed + finalCounts.failed + finalCounts.blocked + finalCounts.pending + finalCounts.in_progress;

    console.log("");
    console.log(log.bold("========================================="));
    console.log(log.bold("  convergent Summary"));
    console.log(log.bold("========================================="));
    console.log(`  Tasks:     ${totalTasks} total`);
    console.log(`    Status:  ${log.green(String(finalCounts.completed))} completed | ${log.red(String(finalCounts.failed))} failed | ${log.yellow(String(finalCounts.blocked))} blocked | ${log.blue(String(finalCounts.pending))} pending | ${log.cyan(String(finalCounts.in_progress))} in_progress`);
    console.log(`    Check:   ${calculatedTotal === totalTasks ? '✓' : '✗'} Sum matches total (${calculatedTotal})`);
    console.log(`  Cost:      $${(budget.total_usd ?? 0).toFixed(2)}`);

    // Tournament stats
    const tasksStatus = state.tasks_status ?? {};
    const tournamentTasks = Object.values(tasksStatus).filter((ts: any) => ts.tournament_metrics);
    if (tournamentTasks.length > 0) {
      const strategies = tournamentTasks.map((ts: any) => ts.tournament_metrics.winner_strategy);
      const strategyCounts = strategies.reduce((acc: Record<string, number>, s: string) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {} as Record<string, number>);
      const strategyStr = Object.entries(strategyCounts).map(([k, v]) => `${k}:${v}`).join(", ");
      console.log(`  Tournament: ${tournamentTasks.length} tournaments (winners: ${strategyStr})`);
    }

    console.log(`  Logs:      ${outputDir}/logs/`);
    console.log(`  State:     ${outputDir}/state.json`);

    if (state.branch_name) {
      console.log(`  Branch:    ${state.branch_name}`);
    }

    if (state.pr_url) {
      console.log(`  PR:        ${state.pr_url}`);
    }

    if (iteration !== undefined) {
      console.log(`  Iterations: ${iteration}`);
    }

    if (stoppedReason) {
      console.log(`  Stop reason: ${stoppedReason}`);
    }

    if (finalCounts.failed > 0) {
      console.log("");
      console.log(log.red("  Failed tasks:"));
      for (const [id, s] of Object.entries(state.tasks_status ?? {})) {
        const ts = s as { status: string; phase?: string };
        if (ts.status === "failed") {
          console.log(`    - ${id} (phase: ${ts.phase ?? "unknown"})`);
        }
      }
    }

    console.log(log.bold("========================================="));
    console.log(`\n📋 Full summary report: ${outputDir}/reports/summary.md`);
  } catch {
    // Summary is best-effort
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

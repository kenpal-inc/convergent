import { existsSync, readFileSync, mkdirSync, cpSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { log } from "./logger";
import { callClaude } from "./claude";
import { recordCost } from "./budget";
import { buildLearningsContext } from "./learnings";
import {
  createWorktree,
  removeWorktree,
  getWorktreeChangedFiles,
  getWorktreeDiff,
} from "./git";
import { resolveVerificationCommands, scoreVerification } from "./verify";
import type {
  Config,
  CompetitorMap,
  CompetitorResult,
  ConvergenceAnalysis,
  TournamentResult,
  Task,
} from "./types";

const STAGGER_MS = 2_000;
const JUDGE_BUDGET_USD = 0.50;

/**
 * Determine how many competitors to run based on task complexity.
 */
function getCompetitorCount(task: Task, config: Config): number {
  const maxCompetitors = config.tournament.competitors;
  switch (task.estimated_complexity) {
    case "trivial": return 1;
    case "standard": return Math.min(2, maxCompetitors);
    case "complex": return maxCompetitors;
    default: return Math.min(2, maxCompetitors);
  }
}

/**
 * Select which strategies to use based on competitor count.
 * trivial=1: pragmatist only
 * standard=2: pragmatist + thorough
 * complex=3: pragmatist + thorough + deconstructor
 */
function selectStrategies(count: number, config: Config): string[] {
  const available = config.tournament.strategies;
  return available.slice(0, count);
}

/**
 * Build the prompt for a fully independent competitor.
 * No shared plan — each competitor explores, plans, and implements on their own.
 */
function buildCompetitorPrompt(
  task: Task,
  learnings: string,
  findingsFromDeps: string,
): string {
  const acceptanceCriteria = (task.acceptance_criteria ?? []).map(c => `- ${c}`).join("\n");
  const contextFiles = (task.context_files ?? []).map(f => `- ${f}`).join("\n");

  return `## Task
Title: ${task.title}
Description: ${task.description}

## Acceptance Criteria
${acceptanceCriteria || "- Task completed as described"}

## Suggested Context Files
${contextFiles || "- Explore the codebase to find relevant files"}
${learnings ? `\n${learnings}\n` : ""}${findingsFromDeps ? `\n## Findings from Exploration Tasks\n${findingsFromDeps}\n` : ""}
## Instructions
Implement this task. You have full access to the codebase. Your approach:
1. Read and understand the relevant code first
2. Decide your implementation strategy
3. Implement the changes
4. Verify your changes compile/parse by reading back modified files

You must satisfy ALL acceptance criteria listed above.`;
}

/**
 * Analyze convergence across successful implementations.
 * Compares which files each competitor changed and computes similarity.
 */
async function analyzeConvergence(
  worktrees: { id: number; strategy: string; path: string }[],
  successfulIds: number[],
): Promise<ConvergenceAnalysis> {
  if (successfulIds.length < 2) {
    return {
      convergence_ratio: 1.0,
      common_files: [],
      divergent_files: [],
      diff_lines: {},
    };
  }

  // Collect changed files and diff sizes for each successful competitor
  const filesPerCompetitor: Map<number, Set<string>> = new Map();
  const diffLines: Record<number, number> = {};

  for (const id of successfulIds) {
    const wt = worktrees.find(w => w.id === id);
    if (!wt) continue;

    const files = await getWorktreeChangedFiles(wt.path);
    filesPerCompetitor.set(id, new Set(files));

    const diff = await getWorktreeDiff(wt.path);
    // Count lines that are additions or deletions (start with + or -)
    const lines = diff.split("\n").filter(l => /^[+-]/.test(l) && !/^[+-]{3}/.test(l));
    diffLines[id] = lines.length;
  }

  // Find common files (changed by ALL successful competitors)
  const allFileSets = Array.from(filesPerCompetitor.values());
  const allFilesUnion = new Set<string>();
  for (const fileSet of allFileSets) {
    for (const f of fileSet) allFilesUnion.add(f);
  }

  const commonFiles: string[] = [];
  const divergentFiles: string[] = [];

  for (const file of allFilesUnion) {
    const changedByAll = allFileSets.every(s => s.has(file));
    if (changedByAll) {
      commonFiles.push(file);
    } else {
      divergentFiles.push(file);
    }
  }

  // Convergence ratio: proportion of files that all competitors agree on
  const totalFiles = allFilesUnion.size;
  const convergence_ratio = totalFiles > 0 ? commonFiles.length / totalFiles : 1.0;

  return {
    convergence_ratio,
    common_files: commonFiles.sort(),
    divergent_files: divergentFiles.sort(),
    diff_lines: diffLines,
  };
}

/**
 * AI judge: compare passing implementations and select the best one.
 * The judge sees each candidate's diff and the task's acceptance criteria,
 * then picks the implementation that best satisfies the requirements.
 *
 * Returns the winner ID and rationale, or null on failure (caller falls back to score+cost).
 */
async function judgeCompetitors(
  task: Task,
  candidates: { id: number; strategy: string; diff: string }[],
  config: Config,
  taskDir: string,
): Promise<{ winnerId: number; rationale: string } | null> {
  if (candidates.length < 2) return null;

  const acceptanceCriteria = (task.acceptance_criteria ?? []).map(c => `- ${c}`).join("\n");

  const candidateSections = candidates.map(c =>
    `### Candidate ${c.id} (${c.strategy})\n\`\`\`diff\n${c.diff.slice(0, 30_000)}\n\`\`\``
  ).join("\n\n");

  const prompt = `## Task
Title: ${task.title}
Description: ${task.description}

## Acceptance Criteria
${acceptanceCriteria || "- Task completed as described"}

## Candidate Implementations
${candidateSections}

## Instructions
Evaluate each candidate against the acceptance criteria and code quality.
Consider:
1. Does it fully satisfy ALL acceptance criteria?
2. Is the code correct and handles edge cases?
3. Is it clean, readable, and follows good practices?
4. Does it integrate well with the existing codebase?

Respond with ONLY a JSON object (no markdown fences):
{"winner": <candidate id number>, "rationale": "<1-2 sentence explanation>"}`;

  try {
    const response = await callClaude({
      prompt,
      systemPrompt: "You are an expert code reviewer judging competing implementations. Be decisive. Pick the best one.",
      model: config.models.planner,
      maxBudgetUsd: JUDGE_BUDGET_USD,
      logFile: `${taskDir}/judge.log`,
    });

    await recordCost(`task-${task.id}-judge`, response.total_cost_usd ?? 0);

    if (response.is_error || !response.result) {
      log.warn("  Judge call failed, falling back to score+cost");
      return null;
    }

    // Parse the JSON response — handle markdown fences just in case
    let text = response.result.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    }

    const parsed = JSON.parse(text);
    const winnerId = parsed.winner;
    const rationale = parsed.rationale ?? "";

    // Validate the winner ID is actually one of our candidates
    if (!candidates.some(c => c.id === winnerId)) {
      log.warn(`  Judge returned invalid winner ID ${winnerId}, falling back`);
      return null;
    }

    return { winnerId, rationale };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`  Judge failed: ${msg}, falling back to score+cost`);
    return null;
  }
}

/**
 * Run a tournament: N fully independent implementations in parallel git worktrees.
 * Each competitor independently reads the codebase, plans, and implements.
 * Verified objectively. Among passing implementations, AI judge selects the best.
 */
export async function runTournament(
  taskId: string,
  task: Task,
  config: Config,
  projectRoot: string,
  outputDir: string,
  libDir: string,
  baseCommit: string,
  findingsFromDeps?: string,
): Promise<TournamentResult | null> {
  const taskDir = `${outputDir}/logs/task-${taskId}`;
  mkdirSync(taskDir, { recursive: true });

  const numCompetitors = getCompetitorCount(task, config);
  const strategyIds = selectStrategies(numCompetitors, config);

  if (numCompetitors === 1) {
    log.phase(`Phase T: Implementing '${task.title}' (single competitor: ${strategyIds[0]})`);
  } else {
    log.phase(`Phase T: Tournament for '${task.title}' (${numCompetitors} competitors: ${strategyIds.join(", ")})`);
  }

  // Load competitor definitions
  const competitors: CompetitorMap = JSON.parse(
    readFileSync(`${libDir}/competitors.json`, "utf-8"),
  );

  // Build shared context pieces (not a plan — just task info + learnings)
  const learnings = await buildLearningsContext(outputDir);
  const findingsSection = findingsFromDeps ?? "";

  // Resolve verification commands (for scoring)
  const verifyCommands = resolveVerificationCommands(config, projectRoot);
  if (verifyCommands.length > 0) {
    log.info(`  Verification: ${verifyCommands.join(", ")}`);
  } else {
    log.warn("  No verification commands — scoring will be limited");
  }

  // Create worktrees in a temp directory OUTSIDE the project tree.
  // This is critical: Claude Code detects project root by traversing upward
  // looking for .claude/ config. If worktrees are inside the project,
  // Claude resolves paths to the main repo and writes files there instead.
  const tournamentDir = join(tmpdir(), `convergent-tournament-${taskId}-${Date.now()}`);
  mkdirSync(tournamentDir, { recursive: true });

  // --- Create worktrees ---
  log.info(`  Creating ${numCompetitors} worktree(s)...`);
  const worktrees: { id: number; strategy: string; path: string }[] = [];

  for (let i = 0; i < numCompetitors; i++) {
    const strategy = strategyIds[i];
    const wtPath = join(tournamentDir, `c-${i}`);
    const ok = await createWorktree(projectRoot, wtPath, baseCommit);
    if (!ok) {
      log.error(`  Failed to create worktree c-${i}`);
      for (const wt of worktrees) {
        await removeWorktree(projectRoot, wt.path);
      }
      try { rmSync(tournamentDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return null;
    }
    worktrees.push({ id: i, strategy, path: wtPath });
  }

  // --- Launch fully independent implementations ---
  log.info(`  Launching ${numCompetitors} independent implementation(s)...`);

  const timeoutMs = config.parallelism.tournament_timeout_seconds * 1000;
  const prompt = buildCompetitorPrompt(task, learnings, findingsSection);

  const implPromises = worktrees.map(async (wt, idx) => {
    const competitor = competitors[wt.strategy];
    if (!competitor) {
      log.warn(`  Strategy '${wt.strategy}' not found, using pragmatist`);
    }

    const systemPrompt = competitor?.system_prompt ??
      competitors["pragmatist"]?.system_prompt ??
      "You are an expert software developer. Read the codebase and implement the task.";

    // Stagger launches to avoid spawn contention
    if (idx > 0) {
      await Bun.sleep(idx * STAGGER_MS);
    }

    log.info(`  Starting competitor c-${wt.id} (${wt.strategy})`);

    const response = await callClaude({
      prompt,
      systemPrompt,
      model: config.models.executor,
      maxBudgetUsd: config.budget.execution_max_usd,
      tools: "Read,Write,Edit,Glob,Grep,Bash",
      dangerouslySkipPermissions: true,
      timeoutMs,
      logFile: `${taskDir}/competitor-${wt.id}.log`,
      cwd: wt.path,
    });

    await Bun.write(
      `${taskDir}/competitor-${wt.id}.json`,
      JSON.stringify(response, null, 2),
    );

    const cost = response.total_cost_usd ?? 0;
    await recordCost(`task-${taskId}-competitor-${wt.id}`, cost);

    return { wt, response, cost, ok: !response.is_error };
  });

  const implResults = await Promise.allSettled(implPromises);

  // --- Score each competitor ---
  log.info("  Scoring competitors...");

  const competitorResults: CompetitorResult[] = [];

  for (const result of implResults) {
    if (result.status === "rejected") {
      log.warn(`  Competitor failed: ${result.reason}`);
      continue;
    }

    const { wt, cost, ok } = result.value;

    if (!ok) {
      log.warn(`  Competitor c-${wt.id} (${wt.strategy}) implementation failed`);
      competitorResults.push({
        id: wt.id,
        strategy: wt.strategy,
        implementationOk: false,
        verificationScore: 0,
        verificationDetails: [],
        cost,
      });
      continue;
    }

    // Check that the competitor actually changed files
    const changedFiles = await getWorktreeChangedFiles(wt.path);
    if (changedFiles.length === 0) {
      log.warn(`  Competitor c-${wt.id} (${wt.strategy}) made no changes ($${cost.toFixed(2)})`);
      competitorResults.push({
        id: wt.id,
        strategy: wt.strategy,
        implementationOk: false,
        verificationScore: 0,
        verificationDetails: [],
        cost,
      });
      continue;
    }

    log.ok(`  Competitor c-${wt.id} (${wt.strategy}) implemented ($${cost.toFixed(2)}, ${changedFiles.length} files)`);

    // Run verification in this worktree
    const score = await scoreVerification(verifyCommands, wt.path);

    log.info(`  Competitor c-${wt.id} score: ${score.totalScore}/${score.maxScore}${score.allPassed ? " ✓" : ""}`);

    competitorResults.push({
      id: wt.id,
      strategy: wt.strategy,
      implementationOk: true,
      verificationScore: score.totalScore,
      verificationDetails: score.details,
      cost,
    });
  }

  // --- Convergence analysis ---
  const successfulIds = competitorResults
    .filter(c => c.implementationOk)
    .map(c => c.id);

  let convergenceAnalysis: ConvergenceAnalysis | undefined;
  if (successfulIds.length >= 2) {
    log.info("  Analyzing convergence...");
    convergenceAnalysis = await analyzeConvergence(worktrees, successfulIds);
    log.info(`  Convergence: ${(convergenceAnalysis.convergence_ratio * 100).toFixed(0)}% file agreement (${convergenceAnalysis.common_files.length} common, ${convergenceAnalysis.divergent_files.length} divergent)`);
  }

  // --- Select winner ---
  // 1. Filter to passing implementations
  // 2. If 2+ pass, AI judge compares diffs and picks the best
  // 3. Fallback: verification score (desc) → cost (asc)
  const passingCompetitors = competitorResults
    .filter(c => c.implementationOk && c.verificationScore > 0);

  // Also keep implementations that "worked" but scored 0 (no verification commands)
  const implementedCompetitors = competitorResults.filter(c => c.implementationOk);

  const candidates = passingCompetitors.length > 0 ? passingCompetitors : implementedCompetitors;

  if (candidates.length === 0) {
    log.error("  All competitors failed — no winner");
    for (const wt of worktrees) {
      await removeWorktree(projectRoot, wt.path);
    }
    try { rmSync(tournamentDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }

  let winner: CompetitorResult;
  let judgeRationale: string | undefined;

  if (candidates.length >= 2) {
    // Collect diffs for the judge (skip candidates with empty diffs)
    log.info("  AI judge evaluating candidates...");
    const allJudgeCandidates = await Promise.all(
      candidates.map(async (c) => {
        const wt = worktrees.find(w => w.id === c.id)!;
        const diff = await getWorktreeDiff(wt.path);
        return { id: c.id, strategy: c.strategy, diff };
      }),
    );
    const judgeCandidates = allJudgeCandidates.filter(c => c.diff.trim().length > 0);

    const judgeResult = await judgeCompetitors(task, judgeCandidates, config, taskDir);

    if (judgeResult) {
      winner = candidates.find(c => c.id === judgeResult.winnerId)!;
      judgeRationale = judgeResult.rationale;
      log.ok(`  Judge picked c-${winner.id} (${winner.strategy}): ${judgeRationale}`);
    } else {
      // Fallback: score → cost
      log.info("  Falling back to score+cost selection");
      candidates.sort((a, b) => {
        if (b.verificationScore !== a.verificationScore) return b.verificationScore - a.verificationScore;
        return a.cost - b.cost;
      });
      winner = candidates[0];
    }
  } else {
    winner = candidates[0];
  }

  const winnerWorktree = worktrees.find(wt => wt.id === winner.id)!;
  const winnerDiffLines = convergenceAnalysis?.diff_lines[winner.id];

  log.ok(`  Winner: c-${winner.id} (${winner.strategy}) — score ${winner.verificationScore}, $${winner.cost.toFixed(2)}${winnerDiffLines !== undefined ? `, ${winnerDiffLines} diff lines` : ""}`);

  // --- Apply winner's changes to main working tree ---
  log.info("  Applying winner's changes...");

  const changedFiles = await getWorktreeChangedFiles(winnerWorktree.path);
  if (changedFiles.length === 0) {
    log.warn("  Winner has no changed files");
  } else {
    for (const file of changedFiles) {
      const srcPath = join(winnerWorktree.path, file);
      const destPath = join(projectRoot, file);
      const destDir = join(projectRoot, file, "..");
      mkdirSync(resolve(destDir), { recursive: true });
      if (existsSync(srcPath)) {
        cpSync(srcPath, destPath, { force: true });
      }
    }
    log.ok(`  Applied ${changedFiles.length} files from winner`);
  }

  // --- Cleanup worktrees and temp directory ---
  for (const wt of worktrees) {
    await removeWorktree(projectRoot, wt.path);
  }
  try { rmSync(tournamentDir, { recursive: true, force: true }); } catch { /* ignore */ }

  const totalCost = competitorResults.reduce((s, c) => s + c.cost, 0);

  const tournamentResult: TournamentResult = {
    winnerId: winner.id,
    winnerStrategy: winner.strategy,
    competitors: competitorResults,
    convergenceAnalysis,
    judgeRationale,
    totalCost,
  };

  // Save tournament result
  await Bun.write(
    `${taskDir}/tournament.json`,
    JSON.stringify(tournamentResult, null, 2),
  );

  return tournamentResult;
}

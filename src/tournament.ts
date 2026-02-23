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
  SemanticConvergenceAnalysis,
  SynthesisMetadata,
  SynthesisResult,
  TournamentResult,
  Task,
} from "./types";

const STAGGER_MS = 2_000;
const JUDGE_BUDGET_USD = 0.50;
const CONVERGENCE_ANALYSIS_BUDGET_USD = 0.50;
const MAX_DIFF_LENGTH = 30_000;

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
  // Flow: synthesis-first-with-fallback
  // 1. Filter to passing implementations
  // 2. If convergence threshold met with 2+ candidates, attempt synthesis
  // 3. If synthesis succeeds and score >= best individual, use synthesis
  // 4. Fallback: AI judge compares diffs → score+cost
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
  let synthesisMetadata: SynthesisMetadata | undefined;
  let synthWorktreePath: string | undefined;
  let synthesisWon = false;
  // sourcePath: where to apply changed files from (synthesis worktree or winner worktree)
  let sourcePath: string | undefined;

  {
    // --- Synthesis path ---
    const convergenceThreshold = config.tournament.convergence_threshold ?? 0.5;

    if (candidates.length >= 2 && convergenceAnalysis && convergenceAnalysis.convergence_ratio >= convergenceThreshold) {
      log.info(`  Convergence threshold met (${(convergenceAnalysis.convergence_ratio * 100).toFixed(0)}% >= ${(convergenceThreshold * 100).toFixed(0)}%), attempting synthesis...`);

      // Collect diffs for all passing candidates
      const diffCandidates = await Promise.all(
        candidates.map(async (c) => {
          const wt = worktrees.find(w => w.id === c.id)!;
          const diff = await getWorktreeDiff(wt.path);
          return { id: c.id, strategy: c.strategy, diff };
        }),
      );

      // Semantic convergence analysis
      const semanticAnalysis = await analyzeSemanticConvergence(task, diffCandidates, config, taskDir, convergenceAnalysis);
      log.info(`  Semantic analysis: synthesis_viable=${semanticAnalysis.synthesis_viable}`);

      if (semanticAnalysis.synthesis_viable) {
        // Attempt synthesis
        const synthResult = await synthesizeImplementation(
          task, diffCandidates, semanticAnalysis, config,
          projectRoot, tournamentDir, taskDir, baseCommit,
        );
        synthWorktreePath = synthResult.worktreePath;

        const bestIndividualScore = Math.max(...candidates.map(c => c.verificationScore));

        if (synthResult.success && synthResult.verification_score >= bestIndividualScore) {
          // Synthesis wins
          log.ok(`  Synthesis score ${synthResult.verification_score} >= best individual ${bestIndividualScore}, using synthesis`);
          synthesisWon = true;
          sourcePath = synthResult.worktreePath;

          // Set winner to the best individual for metadata (winnerId/winnerStrategy reflect source candidates)
          candidates.sort((a, b) => {
            if (b.verificationScore !== a.verificationScore) return b.verificationScore - a.verificationScore;
            return a.cost - b.cost;
          });
          winner = candidates[0];

          synthesisMetadata = {
            attempted: true,
            succeeded: true,
            fell_back_to_winner: false,
            rationale: synthResult.rationale,
            semantic_analysis: semanticAnalysis,
            synthesis_result: synthResult,
          };
        } else {
          // Synthesis failed or scored below best individual — fallback
          const reason = !synthResult.success
            ? `Synthesis failed: ${synthResult.rationale}`
            : `Synthesis score ${synthResult.verification_score} < best individual ${bestIndividualScore}`;
          log.info(`  ${reason}, falling back to judge`);

          synthesisMetadata = {
            attempted: true,
            succeeded: false,
            fell_back_to_winner: true,
            rationale: reason,
            semantic_analysis: semanticAnalysis,
            synthesis_result: synthResult,
          };
        }
      } else {
        // Synthesis not viable
        log.info(`  Synthesis not viable: ${semanticAnalysis.rationale}`);
        synthesisMetadata = {
          attempted: false,
          succeeded: false,
          fell_back_to_winner: true,
          rationale: semanticAnalysis.rationale,
          semantic_analysis: semanticAnalysis,
        };
      }
    } else {
      // Convergence threshold not met
      const ratio = convergenceAnalysis?.convergence_ratio;
      const ratioStr = ratio !== undefined ? (ratio * 100).toFixed(0) : 'N/A';
      const threshStr = (convergenceThreshold * 100).toFixed(0);

      if (candidates.length < 2) {
        log.info(`  Single candidate, skipping synthesis`);
        synthesisMetadata = {
          attempted: false,
          succeeded: false,
          fell_back_to_winner: true,
          rationale: `Only ${candidates.length} candidate(s), synthesis requires 2+`,
        };
      } else {
        log.info(`  Convergence ratio ${ratioStr}% below threshold ${threshStr}%, skipping synthesis`);
        synthesisMetadata = {
          attempted: false,
          succeeded: false,
          fell_back_to_winner: true,
          rationale: `Convergence ratio ${ratioStr}% below threshold ${threshStr}%`,
        };
      }
    }

    // --- Fallback: judge then score+cost (only if synthesis didn't win) ---
    if (!synthesisWon) {
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

      const winnerWorktree = worktrees.find(wt => wt.id === winner!.id)!;
      sourcePath = winnerWorktree.path;
    }
  }

  const winnerDiffLines = convergenceAnalysis?.diff_lines[winner!.id];
  const sourceLabel = synthesisWon ? 'synthesis' : `c-${winner!.id} (${winner!.strategy})`;

  log.ok(`  Winner: ${sourceLabel} — score ${winner!.verificationScore}, $${winner!.cost.toFixed(2)}${winnerDiffLines !== undefined ? `, ${winnerDiffLines} diff lines` : ""}`);

  // --- Apply changes to main working tree ---
  log.info(`  Applying ${synthesisWon ? 'synthesis' : "winner's"} changes...`);

  if (sourcePath) {
    const changedFiles = await getWorktreeChangedFiles(sourcePath);
    if (changedFiles.length === 0) {
      log.warn(`  ${synthesisWon ? 'Synthesis' : 'Winner'} has no changed files`);
    } else {
      for (const file of changedFiles) {
        const srcPath = join(sourcePath, file);
        const destPath = join(projectRoot, file);
        const destDir = join(projectRoot, file, "..");
        mkdirSync(resolve(destDir), { recursive: true });
        if (existsSync(srcPath)) {
          cpSync(srcPath, destPath, { force: true });
        }
      }
      log.ok(`  Applied ${changedFiles.length} files from ${synthesisWon ? 'synthesis' : 'winner'}`);
    }
  }

  // --- Cleanup worktrees and temp directory ---
  if (synthWorktreePath) {
    await removeWorktree(projectRoot, synthWorktreePath).catch(() => {});
  }
  for (const wt of worktrees) {
    await removeWorktree(projectRoot, wt.path);
  }
  try { rmSync(tournamentDir, { recursive: true, force: true }); } catch { /* ignore */ }

  const synthesisCost = synthesisMetadata?.synthesis_result?.cost ?? 0;
  const totalCost = competitorResults.reduce((s, c) => s + c.cost, 0) + synthesisCost;

  const tournamentResult: TournamentResult = {
    winnerId: winner!.id,
    winnerStrategy: synthesisWon ? 'synthesis' : winner!.strategy,
    competitors: competitorResults,
    convergenceAnalysis,
    judgeRationale,
    synthesis: synthesisMetadata,
    totalCost,
  };

  // Save tournament result
  await Bun.write(
    `${taskDir}/tournament.json`,
    JSON.stringify(tournamentResult, null, 2),
  );

  return tournamentResult;
}

/**
 * AI-driven semantic analysis of convergence across tournament implementations.
 * Identifies convergent design decisions, divergent approaches, and assesses
 * whether synthesizing the best parts of multiple implementations is feasible.
 *
 * Gracefully handles all errors — never throws. Returns a fallback with
 * synthesis_viable=false on any failure.
 */
export async function analyzeSemanticConvergence(
  task: Task,
  candidates: { id: number; strategy: string; diff: string }[],
  config: Config,
  taskDir: string,
  convergenceAnalysis: ConvergenceAnalysis,
): Promise<SemanticConvergenceAnalysis> {
  const fallback: SemanticConvergenceAnalysis = {
    convergent_patterns: [],
    divergent_approaches: [],
    synthesis_viable: false,
    rationale: '',
  };

  try {
    // Build candidate diffs section
    const diffsSection = candidates
      .map((c) => {
        const truncated = c.diff.length > MAX_DIFF_LENGTH
          ? c.diff.slice(0, MAX_DIFF_LENGTH) + '\n... (truncated)'
          : c.diff;
        return `### Competitor ${c.id} — Strategy: "${c.strategy}"\n\`\`\`diff\n${truncated}\n\`\`\``;
      })
      .join('\n\n');

    // Build file-level convergence context
    const fileContext = [
      `File-level convergence ratio: ${convergenceAnalysis.convergence_ratio}`,
      `Common files modified by all: ${(convergenceAnalysis.common_files ?? []).join(', ') || 'none'}`,
      `Divergent files (not shared): ${(convergenceAnalysis.divergent_files ?? []).join(', ') || 'none'}`,
    ].join('\n');

    const prompt = `You are analyzing ${candidates.length} independent implementations of the same task to identify convergent design decisions.

## Task
Title: ${task.title}
Description: ${task.description ?? ''}
Acceptance Criteria: ${Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria.join('; ') : (task.acceptance_criteria ?? 'none')}

## File-Level Convergence Metrics
${fileContext}

## Implementation Diffs
${diffsSection}

## Instructions
Perform a SEMANTIC and DIRECTIONAL analysis — focus on high-level convergent design decisions, architectural choices, API designs, data flow decisions, and error handling approaches that multiple implementations independently chose. Do NOT do a line-by-line code comparison.

Identify:
1. **Convergent Patterns**: Architectural choices, API designs, data flow decisions, or error handling approaches that multiple implementations independently chose. For each, note which competitors chose it and your confidence (0-1) that this represents a genuine design convergence.
2. **Divergent Approaches**: Fundamental differences where implementations took completely different directions.
3. **Synthesis Viability**: Whether there is enough convergence to create a meaningful merged/synthesized implementation.

Respond with JSON only:
{
  "convergent_patterns": [{"pattern": "description", "competitors": [0, 1], "confidence": 0.9}],
  "divergent_approaches": ["description of divergence"],
  "synthesis_viable": true,
  "rationale": "explanation of synthesis viability assessment"
}`;

    const systemPrompt = 'You are an expert software architect analyzing convergent evolution across independent implementations. Focus on high-level design decisions, not line-by-line code comparison. Respond with valid JSON only.';

    const response = await callClaude({
      prompt,
      systemPrompt,
      model: config.models.planner,
      maxBudgetUsd: CONVERGENCE_ANALYSIS_BUDGET_USD,
      logFile: `${taskDir}/convergence-analysis.log`,
    });

    // Record cost regardless of success/failure
    recordCost(`task-${task.id}-convergence-analysis`, response.total_cost_usd ?? 0);

    if (response.is_error || !response.result) {
      return { ...fallback, rationale: `AI analysis failed: ${response.result ?? 'empty response'}` };
    }

    // Strip markdown code fences if present
    let raw = response.result.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(raw);

    // Validate and coerce fields with defensive defaults
    const convergent_patterns = Array.isArray(parsed.convergent_patterns)
      ? parsed.convergent_patterns.map((p: any) => ({
          pattern: typeof p === 'string' ? p : (p.pattern ?? ''),
          competitors: Array.isArray(p?.competitors) ? p.competitors : [],
          confidence: typeof p?.confidence === 'number' ? p.confidence : 0.5,
        }))
      : [];

    const divergent_approaches = Array.isArray(parsed.divergent_approaches)
      ? parsed.divergent_approaches.map((d: any) => typeof d === 'string' ? d : String(d))
      : [];

    const synthesis_viable = typeof parsed.synthesis_viable === 'boolean'
      ? parsed.synthesis_viable
      : false;

    const rationale = typeof parsed.rationale === 'string'
      ? parsed.rationale
      : '';

    const result: SemanticConvergenceAnalysis = {
      convergent_patterns,
      divergent_approaches,
      synthesis_viable,
      rationale,
    };

    log.info(`Semantic convergence analysis: ${convergent_patterns.length} convergent patterns found, synthesis_viable=${synthesis_viable}`);

    return result;
  } catch (err: any) {
    log.warn(`Semantic convergence analysis failed: ${err?.message ?? err}`);
    return { ...fallback, rationale: `Analysis error: ${err?.message ?? 'unknown error'}` };
  }
}

/**
 * Build the prompt for convergence synthesis.
 * Extracted as a helper for testability and readability.
 */
function buildSynthesisPrompt(
  task: Task,
  candidates: { id: number; strategy: string; diff: string }[],
  semanticAnalysis: SemanticConvergenceAnalysis,
): string {
  // Task section
  const taskSection = [
    `## Task: ${task.title}`,
    '',
    task.description,
    '',
    '### Acceptance Criteria',
    ...(task.acceptance_criteria ?? []).map((c: string) => `- ${c}`),
  ].join('\n');

  // Candidate diffs section
  const diffsSection = candidates
    .map((c) => {
      const truncated = c.diff.length > MAX_DIFF_LENGTH
        ? c.diff.slice(0, MAX_DIFF_LENGTH) + '\n... [truncated]'
        : c.diff;
      return `### Competitor ${c.id} (${c.strategy})\n\n\`\`\`diff\n${truncated}\n\`\`\``;
    })
    .join('\n\n');

  // Convergent patterns section (cap at 20 to bound prompt size)
  const patternsSection = semanticAnalysis.convergent_patterns
    .slice(0, 20)
    .map(
      (p) =>
        `- [confidence: ${p.confidence.toFixed(2)}] ${p.pattern} (competitors: ${p.competitors.join(', ')})`,
    )
    .join('\n');

  // Divergent approaches section
  const divergentSection = (semanticAnalysis.divergent_approaches ?? [])
    .map((d) => `- ${d}`)
    .join('\n');

  return [
    '# Convergence Synthesis Task',
    '',
    'You are creating a SYNTHESIZED implementation that takes the best expression of each convergent design decision from multiple independent implementations that all passed verification.',
    '',
    taskSection,
    '',
    '## Passing Implementations',
    '',
    `${candidates.length} independent implementations passed verification. Their diffs are shown below:`,
    '',
    diffsSection,
    '',
    '## Convergent Patterns (shared design decisions)',
    '',
    'These patterns were independently chosen by multiple implementations, indicating high-confidence design decisions:',
    '',
    patternsSection,
    '',
    divergentSection
      ? `## Divergent Approaches\n\nThese areas had different approaches across implementations. Choose the approach that best satisfies the acceptance criteria:\n\n${divergentSection}`
      : '',
    '',
    '## Instructions',
    '',
    '1. Read the existing codebase files relevant to this task.',
    '2. Implement a synthesis that embodies ALL convergent patterns listed above.',
    '3. For divergent approaches, choose the approach that best satisfies the acceptance criteria and produces the cleanest code.',
    '4. Do NOT blindly merge diffs — understand the intent behind each pattern and implement the best version.',
    '5. Ensure ALL acceptance criteria are satisfied.',
    '6. Write clean, well-tested code with proper error handling and edge cases.',
  ].join('\n');
}

/**
 * Synthesize the best parts of multiple tournament implementations into a single
 * optimal implementation, guided by semantic convergence analysis.
 *
 * Never throws — returns SynthesisResult with success=false on any failure.
 */
export async function synthesizeImplementation(
  task: Task,
  candidates: { id: number; strategy: string; diff: string }[],
  semanticAnalysis: SemanticConvergenceAnalysis,
  config: Config,
  projectRoot: string,
  tournamentDir: string,
  taskDir: string,
  baseCommit: string,
): Promise<SynthesisResult> {
  let synthPath: string | undefined;
  let cost = 0;

  const failResult = (
    rationale: string,
    opts?: { worktreePath?: string; cost?: number },
  ): SynthesisResult => ({
    success: false,
    diff: '',
    verification_score: 0,
    rationale,
    patterns_incorporated: [],
    worktreePath: opts?.worktreePath,
    cost: opts?.cost ?? 0,
  });

  try {
    // Step 1: Create synthesis worktree
    synthPath = join(tournamentDir, 'synthesis');
    log.info(`  Creating synthesis worktree at ${synthPath}`);
    const wtOk = await createWorktree(projectRoot, synthPath, baseCommit);
    if (!wtOk) {
      return failResult('Failed to create synthesis worktree');
    }

    // Step 2: Build synthesis prompt
    const prompt = buildSynthesisPrompt(task, candidates, semanticAnalysis);

    // Step 3: Call Claude with full tool access in synthesis worktree
    log.info(`  Starting synthesis AI call (budget: $${config.budget.execution_max_usd})`);
    const response = await callClaude({
      prompt,
      systemPrompt:
        'You are an expert software developer creating a synthesized implementation from the best design decisions of multiple independent implementations. Read the existing codebase, understand the convergent patterns identified, and implement the optimal synthesis. Focus on correctness, edge cases, and clean integration.',
      model: config.models.executor,
      maxBudgetUsd: config.budget.execution_max_usd,
      tools: 'Read,Write,Edit,Glob,Grep,Bash',
      dangerouslySkipPermissions: true,
      timeoutMs: config.parallelism.tournament_timeout_seconds * 1000,
      logFile: `${taskDir}/synthesis.log`,
      cwd: synthPath,
    });

    // Step 4: Record cost
    cost = response.total_cost_usd ?? 0;
    await recordCost(`task-${task.id}-synthesis`, cost);
    log.info(`  Synthesis AI call completed (cost: $${cost.toFixed(2)})`);

    // Step 5: Check for AI errors
    if (response.is_error) {
      log.warn(`  Synthesis AI call failed: ${response.result?.slice(0, 200)}`);
      return failResult(
        `Synthesis AI call failed: ${response.result ?? 'unknown error'}`,
        { worktreePath: synthPath, cost },
      );
    }

    // Step 6: Check for file changes
    const changedFiles = await getWorktreeChangedFiles(synthPath);
    if (changedFiles.length === 0) {
      log.warn('  Synthesis produced no file changes');
      return failResult('Synthesis produced no file changes', {
        worktreePath: synthPath,
        cost,
      });
    }

    // Step 7: Run verification
    const verifyCommands = resolveVerificationCommands(config, projectRoot);
    const score = await scoreVerification(verifyCommands, synthPath);
    log.info(
      `  Synthesis verification score: ${score.totalScore}/${score.maxScore}`,
    );

    // Step 8: Get diff
    const diff = await getWorktreeDiff(synthPath);

    // Step 9: Build patterns_incorporated
    const patterns_incorporated = semanticAnalysis.convergent_patterns.map(
      (p) => p.pattern,
    );

    // Step 10: Determine success and return
    const success = score.totalScore > 0 || verifyCommands.length === 0;

    if (success) {
      log.ok(
        `  Synthesis succeeded: ${changedFiles.length} files changed, score ${score.totalScore}/${score.maxScore}, ${patterns_incorporated.length} patterns incorporated`,
      );
    } else {
      log.warn(
        `  Synthesis failed verification: score ${score.totalScore}/${score.maxScore}`,
      );
    }

    return {
      success,
      diff,
      verification_score: score.totalScore,
      rationale: `Synthesis from ${candidates.length} implementations incorporating ${patterns_incorporated.length} convergent patterns. Score: ${score.totalScore}/${score.maxScore}`,
      patterns_incorporated,
      worktreePath: synthPath,
      cost,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`  Synthesis failed with error: ${message}`);
    return failResult(`Synthesis failed: ${message}`, {
      worktreePath: synthPath,
      cost,
    });
  }
}

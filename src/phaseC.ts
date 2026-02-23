import { existsSync, readFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { log } from "./logger";
import { callClaude, getStructuredOutput } from "./claude";
import { recordCost } from "./budget";
import type { Config, ReviewPersona, ReviewPersonaMap, ReviewCriterionCheck, ReviewIssue, ReviewResult, Task } from "./types";

// Fallback system prompt for single-reviewer mode (when no review personas configured)
const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer performing a semantic review of implementation changes.

You have been given:
1. The task description and acceptance criteria that define "done"
2. The actual git diff showing what was implemented
3. Verification results (lint/typecheck/test already passed)

Your job is to perform a SEMANTIC review - mechanical checks (lint, types, tests) have already passed. Focus on:

1. TASK COMPLIANCE: Does the diff implement what the task requires? Are there missing pieces? Extra changes beyond the scope?
2. ACCEPTANCE CRITERIA: Does each criterion appear to be satisfied by the changes?
3. CODE QUALITY ISSUES: Look for:
   - Unnecessary changes (files modified beyond what the task requires)
   - Security problems (hardcoded secrets, SQL injection, XSS, missing input validation)
   - Missing error handling for critical paths
   - Broken patterns (inconsistency with surrounding codebase conventions)
   - Dead code or debug artifacts left behind
   - Overly broad changes that could cause regressions
4. COMPLETENESS: Does the diff fully address the task description?

Be practical. Minor style issues that passed linting are not worth flagging. Focus on issues that would matter in a real code review.

If the implementation is sound, approve it. Only request changes for genuine issues.`;

const MAX_DIFF_CHARS = 30_000;

// --- Shared context preparation ---

interface ReviewContext {
  prompt: string;
  reviewSchema: object;
  /** Snapshot of current diff for differential comparison on retries */
  diffSnapshot: string;
}

export interface ReviewRetryInfo {
  previousDiffSnapshot: string;
  previousFeedback: string;
}

function makeErrorResult(summary: string): ReviewResult {
  return {
    verdict: "error",
    summary,
    plan_compliance: { compliant: false, missing_steps: [], extra_changes: [], notes: summary },
    acceptance_criteria_check: [],
    issues: [],
  };
}

async function prepareReviewContext(
  taskId: string,
  task: Task,
  outputDir: string,
  projectRoot: string,
  templatesDir: string,
  retryInfo?: ReviewRetryInfo,
  baseCommit?: string,
): Promise<{ context: ReviewContext; earlyReturn?: never } | { context?: never; earlyReturn: ReviewResult }> {
  const taskDir = `${outputDir}/logs/task-${taskId}`;

  // Get git diff (all changes since base commit, including any intermediate commits by review fix)
  const gitDiff = await getGitDiffUncommitted(projectRoot, baseCommit);
  const gitDiffStat = await getGitDiffStatUncommitted(projectRoot, baseCommit);

  if (!gitDiff.trim()) {
    log.warn("No changes detected in git diff - nothing to review");
    return {
      earlyReturn: {
        verdict: "approved",
        summary: "No changes to review",
        plan_compliance: { compliant: true, missing_steps: [], extra_changes: [] },
        acceptance_criteria_check: [],
        issues: [],
      },
    };
  }

  // Read verify.log
  const verifyLogPath = `${taskDir}/verify.log`;
  const verifyLog = existsSync(verifyLogPath)
    ? readFileSync(verifyLogPath, "utf-8")
    : "Verification output not available";

  // Build acceptance criteria text
  const acceptanceCriteria = (task.acceptance_criteria ?? [])
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");

  // Build context files text
  const contextFiles = (task.context_files ?? [])
    .map(f => `- ${f}`)
    .join("\n");

  // Load review schema
  const reviewSchema = await Bun.file(`${templatesDir}/review_result.schema.json`).json();

  // Truncate diff if too large
  let diffForReview = gitDiff;
  if (diffForReview.length > MAX_DIFF_CHARS) {
    diffForReview = diffForReview.slice(0, MAX_DIFF_CHARS)
      + `\n... [truncated, ${gitDiff.length} total chars]`;
  }

  let prompt: string;

  if (retryInfo) {
    // Differential review: focus on what changed since last review
    prompt = `## Task
Title: ${task.title}
Description: ${task.description}

## Acceptance Criteria
${acceptanceCriteria || "(none specified)"}

## Expected Context Files
${contextFiles || "(none specified)"}

## Previous Review Feedback (issues that were supposed to be fixed)
${retryInfo.previousFeedback}

## Git Diff Summary (--stat)
${gitDiffStat}

## Git Diff (full, current state)
${diffForReview}

## Verification Results
${verifyLog}

## Instructions
This is a RE-REVIEW after the developer attempted to fix issues from the previous review.
Focus on:
1. Whether the previously identified issues have been properly fixed
2. Whether the fixes introduced any new problems
3. Whether the overall implementation still meets the task requirements and acceptance criteria
Approve if the previous issues are resolved and no new significant issues were introduced.`;
  } else {
    prompt = `## Task
Title: ${task.title}
Description: ${task.description}

## Acceptance Criteria
${acceptanceCriteria || "(none specified)"}

## Expected Context Files
${contextFiles || "(none specified)"}

## Git Diff Summary (--stat)
${gitDiffStat}

## Git Diff (full)
${diffForReview}

## Verification Results
${verifyLog}

## Instructions
Review the git diff against the task description and acceptance criteria. Determine whether to approve or request changes.`;
  }

  return { context: { prompt, reviewSchema, diffSnapshot: gitDiff } };
}

// --- Single persona review execution ---

async function runSingleReview(
  taskId: string,
  personaId: string,
  persona: ReviewPersona,
  reviewContext: ReviewContext,
  config: Config,
  taskDir: string,
): Promise<{ personaId: string; result: ReviewResult; cost: number } | null> {
  const timeoutMs = config.parallelism.tournament_timeout_seconds * 1000;

  const response = await callClaude({
    prompt: reviewContext.prompt,
    systemPrompt: persona.system_prompt,
    model: config.models.executor,
    maxBudgetUsd: config.budget.per_review_persona_max_usd ?? config.budget.review_max_usd ?? 2.00,
    jsonSchema: reviewContext.reviewSchema,
    tools: "",
    timeoutMs,
    logFile: `${taskDir}/review-${personaId}.log`,
  });

  await Bun.write(`${taskDir}/review-${personaId}.json`, JSON.stringify(response, null, 2));

  const cost = response.total_cost_usd ?? 0;
  await recordCost(`task-${taskId}-review-${personaId}`, cost);

  if (response.is_error) {
    log.warn(`  Review persona '${personaId}' failed: ${response.result}`);
    return null;
  }

  const reviewResult = getStructuredOutput<ReviewResult>(response);
  if (!reviewResult) {
    log.warn(`  Review persona '${personaId}' produced no structured output`);
    return null;
  }

  log.ok(`  Review persona '${personaId}' ($${cost.toFixed(2)}): ${reviewResult.verdict}`);
  return { personaId, result: reviewResult, cost };
}

// --- Deterministic merge of multiple ReviewResults ---

export function mergeReviewResults(
  results: { personaId: string; result: ReviewResult }[],
): ReviewResult {
  // Severity-aware verdict: only error/warning issues block; info-only → treated as approved
  let finalVerdict: ReviewResult["verdict"] = "approved";
  const summaryParts: string[] = [];

  for (const { personaId, result } of results) {
    if (result.verdict === "changes_requested") {
      // Check if there are any blocking issues (error or warning)
      const blockingIssues = (result.issues ?? []).filter(
        i => i.severity === "error" || i.severity === "warning",
      );
      if (blockingIssues.length > 0) {
        finalVerdict = "changes_requested";
        summaryParts.push(`[${personaId}] ${result.verdict}: ${result.summary}`);
      } else {
        // Info-only changes_requested → treat as approved with notes
        log.info(`  Review persona '${personaId}' requested changes but only has info-level issues — treating as approved`);
        summaryParts.push(`[${personaId}] approved (info-only demoted): ${result.summary}`);
      }
    } else {
      summaryParts.push(`[${personaId}] ${result.verdict}: ${result.summary}`);
    }
  }

  // Plan compliance: union of missing_steps and extra_changes (deduplicated)
  const allMissingSteps = new Set<string>();
  const allExtraChanges = new Set<string>();
  let anyNonCompliant = false;
  const complianceNotes: string[] = [];

  for (const { result } of results) {
    const pc = result.plan_compliance;
    if (!pc.compliant) anyNonCompliant = true;
    for (const step of pc.missing_steps) allMissingSteps.add(step);
    for (const change of pc.extra_changes) allExtraChanges.add(change);
    if (pc.notes) complianceNotes.push(pc.notes);
  }

  // Acceptance criteria: if any persona says not satisfied, mark as not satisfied
  const criteriaMap = new Map<string, ReviewCriterionCheck>();
  for (const { result } of results) {
    for (const check of result.acceptance_criteria_check ?? []) {
      const existing = criteriaMap.get(check.criterion);
      if (!existing) {
        criteriaMap.set(check.criterion, { ...check });
      } else if (!check.satisfied) {
        criteriaMap.set(check.criterion, {
          criterion: check.criterion,
          satisfied: false,
          evidence: `${existing.evidence}; ${check.evidence}`,
        });
      }
    }
  }

  // Issues: merge all, tag with source persona
  const allIssues: ReviewIssue[] = [];
  for (const { personaId, result } of results) {
    for (const issue of result.issues ?? []) {
      allIssues.push({
        ...issue,
        description: `[${personaId}] ${issue.description}`,
      });
    }
  }

  return {
    verdict: finalVerdict,
    summary: summaryParts.join(" | "),
    plan_compliance: {
      compliant: !anyNonCompliant,
      missing_steps: [...allMissingSteps],
      extra_changes: [...allExtraChanges],
      notes: complianceNotes.join("; ") || undefined,
    },
    acceptance_criteria_check: [...criteriaMap.values()],
    issues: allIssues,
  };
}

// --- Legacy single-reviewer fallback ---

async function runSingleReviewLegacy(
  taskId: string,
  reviewContext: ReviewContext,
  config: Config,
  taskDir: string,
): Promise<ReviewResult> {
  log.info("Calling claude for code review (single reviewer)...");

  const response = await callClaude({
    prompt: reviewContext.prompt,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    model: config.models.executor,
    maxBudgetUsd: config.budget.review_max_usd ?? 2.00,
    jsonSchema: reviewContext.reviewSchema,
    tools: "",
    logFile: `${taskDir}/review.log`,
  });

  await Bun.write(`${taskDir}/review.json`, JSON.stringify(response, null, 2));

  const cost = response.total_cost_usd ?? 0;
  await recordCost(`task-${taskId}-review`, cost);

  if (response.is_error) {
    log.error("Code review call failed");
    return makeErrorResult(`Review call failed: ${response.result}`);
  }

  const reviewResult = getStructuredOutput<ReviewResult>(response);
  if (!reviewResult) {
    log.error("Code review produced no structured output");
    return makeErrorResult("Review produced no structured output");
  }

  log.ok(`Code review completed ($${cost.toFixed(2)}): ${reviewResult.verdict}`);
  logReviewVerdict(reviewResult);
  return reviewResult;
}

// --- Main entry point ---

export async function runPhaseC(
  taskId: string,
  task: Task,
  config: Config,
  projectRoot: string,
  outputDir: string,
  templatesDir: string,
  retryInfo?: ReviewRetryInfo,
  baseCommit?: string,
): Promise<ReviewResult> {
  const taskDir = `${outputDir}/logs/task-${taskId}`;
  mkdirSync(taskDir, { recursive: true });

  log.phase(`Phase C: Code review for '${task.title}'`);

  // Prepare shared context
  const prepared = await prepareReviewContext(taskId, task, outputDir, projectRoot, templatesDir, retryInfo, baseCommit);
  if (prepared.earlyReturn) {
    return prepared.earlyReturn;
  }
  const reviewContext = prepared.context;

  // Determine reviewer persona IDs
  const reviewPersonaIds = config.review?.personas ?? [];

  if (reviewPersonaIds.length === 0) {
    // Fallback: single-reviewer mode (backward compatibility)
    return runSingleReviewLegacy(taskId, reviewContext, config, taskDir);
  }

  // Load review persona definitions
  const libDir = resolve(dirname(new URL(import.meta.url).pathname), "../lib");
  const reviewPersonasPath = `${libDir}/review_personas.json`;
  if (!existsSync(reviewPersonasPath)) {
    log.warn("review_personas.json not found, falling back to single reviewer");
    return runSingleReviewLegacy(taskId, reviewContext, config, taskDir);
  }
  const reviewPersonas: ReviewPersonaMap = JSON.parse(readFileSync(reviewPersonasPath, "utf-8"));

  log.info(`Launching ${reviewPersonaIds.length} review personas in parallel...`);

  // Launch all review personas in parallel (Phase A pattern)
  const results = await Promise.allSettled(
    reviewPersonaIds.map((personaId) => {
      const persona = reviewPersonas[personaId];
      if (!persona) {
        log.warn(`  Review persona '${personaId}' not found in review_personas.json, skipping`);
        return Promise.resolve(null);
      }
      log.info(`  Starting review persona: ${personaId} (${persona.name})`);
      return runSingleReview(taskId, personaId, persona, reviewContext, config, taskDir);
    }),
  );

  // Collect successful results
  let succeeded = 0;
  let failed = 0;
  const successfulReviews: { personaId: string; result: ReviewResult }[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      failed++;
      log.warn(`  Review persona failed: ${result.reason}`);
      continue;
    }
    const value = result.value;
    if (!value) {
      failed++;
      continue;
    }
    succeeded++;
    successfulReviews.push({ personaId: value.personaId, result: value.result });
  }

  log.info(`Review personas: ${succeeded} succeeded, ${failed} failed`);

  // Minimum threshold: need at least 2 successful reviews
  const minRequired = 2;
  if (succeeded < minRequired) {
    log.warn(`Too few review personas succeeded (${succeeded} < ${minRequired}), treating as non-fatal error`);
    return makeErrorResult(`Only ${succeeded}/${reviewPersonaIds.length} review personas completed (need ${minRequired})`);
  }

  // Merge results deterministically
  const mergedResult = mergeReviewResults(successfulReviews);

  // Write merged result
  await Bun.write(`${taskDir}/review.json`, JSON.stringify(mergedResult, null, 2));

  // Log verdict
  logReviewVerdict(mergedResult, succeeded);

  return mergedResult;
}

// --- Shared logging ---

function logReviewVerdict(result: ReviewResult, personaCount?: number): void {
  const suffix = personaCount ? ` (${personaCount} personas)` : "";
  if (result.verdict === "approved") {
    log.ok(`Review: APPROVED${suffix}`);
    if (result.issues?.length) {
      log.info(`  Minor notes: ${result.issues.length} (non-blocking)`);
    }
  } else {
    log.warn(`Review: CHANGES REQUESTED (${result.issues?.length ?? 0} issues)${suffix}`);
    for (const issue of result.issues ?? []) {
      log.warn(`  - [${issue.severity}] ${issue.file_path ?? "general"}: ${issue.description}`);
    }
  }
}

// --- Review feedback builder ---

export function buildReviewFeedback(reviewResult: ReviewResult): string {
  const lines: string[] = [];

  lines.push("## Code Review Feedback");
  lines.push("");
  lines.push(`**Verdict**: ${reviewResult.verdict}`);
  lines.push(`**Summary**: ${reviewResult.summary}`);
  lines.push("");

  const pc = reviewResult.plan_compliance;
  if (!pc.compliant) {
    lines.push("### Plan Compliance Issues");
    if (pc.missing_steps.length > 0) {
      lines.push("**Missing steps from the plan:**");
      for (const step of pc.missing_steps) {
        lines.push(`- ${step}`);
      }
    }
    if (pc.extra_changes.length > 0) {
      lines.push("**Extra changes not in plan (remove or justify):**");
      for (const change of pc.extra_changes) {
        lines.push(`- ${change}`);
      }
    }
    if (pc.notes) {
      lines.push(`**Notes:** ${pc.notes}`);
    }
    lines.push("");
  }

  const failedCriteria = (reviewResult.acceptance_criteria_check ?? [])
    .filter(c => !c.satisfied);
  if (failedCriteria.length > 0) {
    lines.push("### Unsatisfied Acceptance Criteria");
    for (const c of failedCriteria) {
      lines.push(`- **${c.criterion}**: ${c.evidence}`);
    }
    lines.push("");
  }

  const blockingIssues = (reviewResult.issues ?? [])
    .filter(i => i.severity === "error" || i.severity === "warning");
  if (blockingIssues.length > 0) {
    lines.push("### Issues to Fix");
    for (const issue of blockingIssues) {
      lines.push(`- [${issue.severity}] ${issue.file_path ?? "general"}: ${issue.description}`);
      if (issue.suggestion) {
        lines.push(`  Suggestion: ${issue.suggestion}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- Git helpers ---

async function getGitDiffUncommitted(projectRoot: string, baseCommit?: string): Promise<string> {
  const diffRef = baseCommit ?? "HEAD";
  const proc = Bun.spawn(["git", "diff", diffRef], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const untrackedProc = Bun.spawn(
    ["git", "ls-files", "--others", "--exclude-standard"],
    { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
  );
  const untracked = await new Response(untrackedProc.stdout).text();
  await untrackedProc.exited;

  let result = stdout;
  if (untracked.trim()) {
    // Read content of untracked files for the reviewer
    const untrackedFiles = untracked.trim().split("\n").filter(Boolean);
    result += "\n\n--- New (untracked) files ---\n";
    for (const file of untrackedFiles.slice(0, 20)) {
      result += `\n+++ ${file}\n`;
      try {
        const content = readFileSync(`${projectRoot}/${file}`, "utf-8");
        result += content.slice(0, 2000);
        if (content.length > 2000) result += "\n... [truncated]";
      } catch {
        result += "(could not read file)";
      }
      result += "\n";
    }
  }
  return result;
}

async function getGitDiffStatUncommitted(projectRoot: string, baseCommit?: string): Promise<string> {
  const diffRef = baseCommit ?? "HEAD";
  const proc = Bun.spawn(["git", "diff", "--stat", diffRef], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

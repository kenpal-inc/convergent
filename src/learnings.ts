/**
 * Inter-task learning module — accumulates review feedback and failure patterns
 * from completed tasks and provides them as context to subsequent tasks.
 */

import { existsSync, readFileSync } from "fs";
import { log } from "./logger";

const LEARNINGS_FILE = "learnings.json";

export interface Learning {
  taskId: string;
  type: "review_feedback" | "failure_pattern" | "verification_failure";
  summary: string;
  timestamp: string;
}

export interface LearningsStore {
  learnings: Learning[];
}

function learningsPath(outputDir: string): string {
  return `${outputDir}/${LEARNINGS_FILE}`;
}

/**
 * Simple similarity check to deduplicate learnings.
 * Normalizes strings and checks if one contains the other or they share high overlap.
 */
function isSimilar(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Token overlap: if >80% of words match, consider similar
  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const minLen = Math.min(wordsA.size, wordsB.size);
  return minLen > 0 && intersection / minLen >= 0.8;
}

function isDuplicate(existing: Learning[], newEntry: { type: string; summary: string }): boolean {
  return existing.some(
    e => e.type === newEntry.type && isSimilar(e.summary, newEntry.summary),
  );
}

async function readLearnings(outputDir: string): Promise<LearningsStore> {
  const path = learningsPath(outputDir);
  if (!existsSync(path)) return { learnings: [] };
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { learnings: [] };
  }
}

async function writeLearnings(outputDir: string, store: LearningsStore): Promise<void> {
  await Bun.write(learningsPath(outputDir), JSON.stringify(store, null, 2));
}

/**
 * Record a learning from a completed task's review feedback.
 */
export async function recordReviewLearning(
  outputDir: string,
  taskId: string,
  issues: string[],
): Promise<void> {
  if (issues.length === 0) return;

  const store = await readLearnings(outputDir);
  const summary = issues.join("; ");
  if (isDuplicate(store.learnings, { type: "review_feedback", summary })) {
    log.debug(`Skipping duplicate review learning from task ${taskId}`);
    return;
  }
  store.learnings.push({
    taskId,
    type: "review_feedback",
    summary,
    timestamp: new Date().toISOString(),
  });
  await writeLearnings(outputDir, store);
  log.debug(`Recorded review learning from task ${taskId}`);
}

/**
 * Record a learning from a task failure (Phase B or verification).
 */
export async function recordFailureLearning(
  outputDir: string,
  taskId: string,
  phase: string,
  errorSummary: string,
): Promise<void> {
  const store = await readLearnings(outputDir);
  const type = phase === "verify" ? "verification_failure" : "failure_pattern";
  if (isDuplicate(store.learnings, { type, summary: errorSummary })) {
    log.debug(`Skipping duplicate failure learning from task ${taskId} (${phase})`);
    return;
  }
  store.learnings.push({
    taskId,
    type: type as Learning["type"],
    summary: errorSummary,
    timestamp: new Date().toISOString(),
  });
  await writeLearnings(outputDir, store);
  log.debug(`Recorded failure learning from task ${taskId} (${phase})`);
}

/**
 * Build a markdown section summarizing accumulated learnings
 * for inclusion in Phase B/A prompts of subsequent tasks.
 * Returns empty string if no learnings exist.
 */
export async function buildLearningsContext(outputDir: string): Promise<string> {
  const store = await readLearnings(outputDir);
  if (store.learnings.length === 0) return "";

  const lines: string[] = [
    "## Learnings from Previous Tasks (IMPORTANT: avoid repeating these mistakes)",
    "",
  ];

  const reviewFeedback = store.learnings.filter(l => l.type === "review_feedback");
  const failures = store.learnings.filter(l => l.type !== "review_feedback");

  if (reviewFeedback.length > 0) {
    lines.push("### Review Feedback Patterns");
    for (const l of reviewFeedback.slice(-10)) { // Last 10 entries
      lines.push(`- [${l.taskId}] ${l.summary}`);
    }
    lines.push("");
  }

  if (failures.length > 0) {
    lines.push("### Failure Patterns (DO NOT repeat these)");
    for (const l of failures.slice(-10)) { // Last 10 entries
      lines.push(`- [${l.taskId}/${l.type}] ${l.summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

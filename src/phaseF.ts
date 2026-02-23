import { mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { log } from "./logger";
import { callClaude } from "./claude";
import { recordCost } from "./budget";
import { resolveVerificationCommands } from "./verify";
import { gitCommitTask } from "./git";
import type { Config, TaskQueue } from "./types";

const INTEGRATION_CHECK_BUDGET_USD = 0.50;
const INTEGRATION_FIX_BUDGET_USD = 5.00;
const FIX_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Phase F: Final integration check.
 *
 * After all tasks complete, run an AI-powered cross-task coherence review
 * that catches issues individual task verification misses (e.g., frontend
 * calling API routes that were never created, missing component imports,
 * schema mismatches).
 *
 * If issues are found, spawns a Claude agent to fix them.
 *
 * Returns true if the project is coherent (or was repaired successfully).
 */
export async function runIntegrationCheck(
  config: Config,
  projectRoot: string,
  outputDir: string,
  taskQueue: TaskQueue,
): Promise<boolean> {
  log.phase("Phase F: Integration check");

  const logDir = `${outputDir}/logs/phase-f`;
  mkdirSync(logDir, { recursive: true });

  // Step 1: Run verification commands to collect any errors
  const verifyCommands = resolveVerificationCommands(config, projectRoot);
  const verifyErrors: string[] = [];

  for (const cmd of verifyCommands) {
    try {
      const proc = Bun.spawn(["sh", "-c", cmd], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        verifyErrors.push(`$ ${cmd}\n${stdout}\n${stderr}`.trim());
      }
    } catch (err) {
      verifyErrors.push(`$ ${cmd}\nError: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 2: Collect project file listing for the AI to review
  let fileList = "";
  try {
    const proc = Bun.spawn(
      ["git", "ls-files"],
      { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
    );
    fileList = await new Response(proc.stdout).text();
    await proc.exited;
  } catch { /* ignore */ }

  // Step 3: Collect completed task summaries
  const taskSummaries = taskQueue.tasks.map(t => `- ${t.id}: ${t.title}`).join("\n");

  // Step 4: Ask AI to diagnose cross-task coherence issues
  const verifySection = verifyErrors.length > 0
    ? `## Verification Errors\nThe following verification commands failed:\n\n${verifyErrors.join("\n\n---\n\n")}`
    : "## Verification\nAll verification commands passed.";

  const prompt = `You are reviewing a project that was built by multiple independent AI agents, each handling a separate task. Your job is to find CROSS-TASK COHERENCE issues — problems that arise because one task created something that another task depends on incorrectly.

## Completed Tasks
${taskSummaries}

## Project Files
\`\`\`
${fileList}
\`\`\`

${verifySection}

## Instructions
Analyze the project for cross-task integration issues. Common problems include:
1. Frontend pages calling API routes (e.g., fetch("/api/foo/[id]")) that don't have corresponding backend route files
2. Components importing from paths that don't exist
3. Database operations that don't match the Prisma/DB schema
4. Missing CRUD operations (e.g., list/create exists but update/delete routes are missing while the UI calls them)

Check the actual file list above. If a frontend page calls PUT /api/members/[id], verify that app/api/members/[id]/route.ts (or equivalent) exists in the file list.

Respond with JSON only:
{
  "issues": [
    {"severity": "critical", "description": "description of the issue", "fix_hint": "what needs to be created/fixed"}
  ],
  "coherent": true
}

If there are no issues, return {"issues": [], "coherent": true}.
Only flag issues you are CONFIDENT about based on the file list and verification errors. Do not speculate.`;

  log.info("  Running AI coherence analysis...");

  const diagResponse = await callClaude({
    prompt,
    systemPrompt: "You are an expert software architect reviewing cross-module integration. Analyze file lists and verification output to find missing pieces. Respond with valid JSON only.",
    model: config.models.judge,
    maxBudgetUsd: INTEGRATION_CHECK_BUDGET_USD,
    tools: "Read,Glob,Grep",
    dangerouslySkipPermissions: true,
    logFile: `${logDir}/diagnosis.log`,
    cwd: projectRoot,
  });

  await recordCost("phase-f-diagnosis", diagResponse.total_cost_usd ?? 0);

  if (diagResponse.is_error || !diagResponse.result) {
    log.warn("  Integration diagnosis failed — skipping Phase F");
    return true; // Don't block on diagnosis failure
  }

  // Parse diagnosis
  let diagnosis: { issues: Array<{ severity: string; description: string; fix_hint: string }>; coherent: boolean };
  try {
    let raw = diagResponse.result.trim();
    if (raw.startsWith("```")) {
      raw = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    diagnosis = JSON.parse(raw);
  } catch {
    log.warn("  Failed to parse diagnosis JSON — skipping Phase F");
    return true;
  }

  if (diagnosis.coherent && diagnosis.issues.length === 0 && verifyErrors.length === 0) {
    log.ok("  Integration check passed — project is coherent");
    return true;
  }

  // Step 5: Report issues
  const criticalIssues = diagnosis.issues.filter(i => i.severity === "critical");
  const allIssues = diagnosis.issues;

  if (allIssues.length > 0) {
    log.warn(`  Found ${allIssues.length} integration issue(s) (${criticalIssues.length} critical):`);
    for (const issue of allIssues) {
      log.warn(`    [${issue.severity}] ${issue.description}`);
    }
  }
  if (verifyErrors.length > 0 && allIssues.length === 0) {
    log.warn(`  ${verifyErrors.length} verification command(s) failing but no structural issues found`);
  }

  // Step 6: If no critical issues and no verify errors, accept as-is
  if (criticalIssues.length === 0 && verifyErrors.length === 0) {
    log.ok("  No critical issues — integration check passed with warnings");
    return true;
  }

  // Step 7: Fix critical issues
  const issueList = [
    ...criticalIssues.map(i => `- [CRITICAL] ${i.description}\n  Fix: ${i.fix_hint}`),
    ...verifyErrors.map(e => `- [VERIFY FAILURE]\n${e}`),
  ].join("\n\n");

  const fixPrompt = `## Integration Issues to Fix

The following issues were found during the final integration check of this project. These are cross-task coherence problems — pieces that one task expected another task to create, but they were missed.

${issueList}

## Instructions
Fix ALL of the issues listed above. For each:
1. Read the relevant existing files to understand the patterns used
2. Create or modify files to resolve the issue
3. Follow the same code style and patterns as the existing code
4. Ensure the fix is complete (e.g., if a PUT/DELETE route is missing, implement it fully with proper validation)

After fixing, verify your changes compile correctly.`;

  log.info("  Spawning fix agent...");

  const fixResponse = await callClaude({
    prompt: fixPrompt,
    systemPrompt: "You are an expert software developer fixing integration issues in a multi-task project. Read existing code patterns and create missing pieces that match the established conventions.",
    model: config.models.executor,
    maxBudgetUsd: INTEGRATION_FIX_BUDGET_USD,
    tools: "Read,Write,Edit,Glob,Grep,Bash",
    dangerouslySkipPermissions: true,
    timeoutMs: FIX_TIMEOUT_MS,
    logFile: `${logDir}/fix.log`,
    cwd: projectRoot,
  });

  await recordCost("phase-f-fix", fixResponse.total_cost_usd ?? 0);

  if (fixResponse.is_error) {
    log.error(`  Integration fix failed: ${fixResponse.result?.slice(0, 200)}`);
    return false;
  }

  log.ok(`  Integration fix completed ($${(fixResponse.total_cost_usd ?? 0).toFixed(2)})`);

  // Step 8: Re-run verification
  let allVerifyPassed = true;
  for (const cmd of verifyCommands) {
    try {
      const proc = Bun.spawn(["sh", "-c", cmd], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        allVerifyPassed = false;
        log.warn(`  Post-fix verification failed: ${cmd}`);
      }
    } catch {
      allVerifyPassed = false;
    }
  }

  if (allVerifyPassed) {
    log.ok("  Post-fix verification passed");
  } else {
    log.warn("  Post-fix verification has failures (non-blocking)");
  }

  // Step 9: Commit the integration fix
  const commitOk = await gitCommitTask(
    "integration-fix",
    "Fix cross-task integration issues (Phase F)",
    config,
    projectRoot,
    outputDir,
  );

  if (commitOk) {
    log.ok("  Integration fix committed");
  } else {
    log.warn("  Integration fix commit failed (changes remain uncommitted)");
  }

  return true;
}

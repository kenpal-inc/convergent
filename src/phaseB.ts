import { existsSync, readFileSync, mkdirSync } from "fs";
import { log } from "./logger";
import { callClaude, getStructuredOutput } from "./claude";
import { buildTaskContext } from "./context";
import { recordCost } from "./budget";
import { buildLearningsContext } from "./learnings";
import type { Config, ConvergedPlan, Task } from "./types";

// --- Explore task ---

const EXPLORE_SYSTEM_PROMPT = `You are an expert QA engineer and investigator. Your job is to explore, test, and gather information.

Rules:
- Use all available tools (browser, CLI, file system) to investigate the task thoroughly.
- Record your findings in detail: what you tested, what worked, what failed, what bugs you found.
- Be systematic: cover all the scenarios described in the task description.
- Take screenshots when you find issues (if browser tools are available).
- Your output should be a comprehensive report of findings.
- At the end, write a structured summary of all findings to the findings file specified in the instructions.
- Do NOT modify source code. Your job is to observe and report, not to fix.`;

// --- Command task ---

const COMMAND_SYSTEM_PROMPT = `You are a DevOps engineer executing deployment and infrastructure commands.

Rules:
- Execute the commands described in the task description.
- Verify that commands succeed before proceeding to the next one.
- If a command fails, report the error clearly.
- Record the output of each command for reference.
- Do NOT modify source code unless the task description explicitly requires it.`;

// --- Code task (existing) ---

const EXECUTION_SYSTEM_PROMPT = `You are an expert software developer executing a precise implementation plan.

Rules:
- Follow the implementation plan step by step. Do not deviate unless you find a clear error.
- Create all files and make all changes specified in the plan.
- Write all test files and test cases specified in the plan.
- Read existing files first before modifying them to understand current state.
- Ensure your code follows the patterns and conventions already present in the codebase.
- After completing implementation, verify that new code compiles/parses correctly.
- Do not make changes outside the scope of the plan.
- Do not add extra features, refactoring, or improvements beyond what the plan specifies.`;

const FIX_SYSTEM_PROMPT = `You are an expert software developer fixing verification failures. The previous implementation attempt failed lint, typecheck, or tests. Your job is to fix the issues while staying true to the original implementation plan.

Rules:
- Focus on fixing the specific errors shown in the verification output.
- Do not make unrelated changes.
- Read the affected files to understand their current state before making fixes.
- If a test is failing, understand why and fix the implementation (not the test), unless the test itself has a bug.
- Maintain consistency with existing codebase patterns.`;

const REVIEW_FIX_SYSTEM_PROMPT = `You are an expert software developer fixing issues found during code review. The implementation passed lint, typecheck, and tests, but a semantic code review identified problems.

Rules:
- Fix the specific issues identified in the code review feedback.
- Pay special attention to plan compliance - if steps were missed, implement them.
- If the review flagged extra/unnecessary changes, remove them.
- Address unsatisfied acceptance criteria.
- Do not make unrelated changes.
- Read the affected files to understand their current state before making fixes.
- Maintain consistency with existing codebase patterns.`;

export async function runPhaseB(
  taskId: string,
  task: Task,
  config: Config,
  projectRoot: string,
  outputDir: string,
  findingsFromDeps?: string,
): Promise<boolean> {
  const taskDir = `${outputDir}/logs/task-${taskId}`;
  mkdirSync(taskDir, { recursive: true });

  log.phase(`Phase B: Implementing '${task.title}'`);

  // Load converged plan
  const synthesisPath = `${taskDir}/synthesis.json`;
  if (!existsSync(synthesisPath)) {
    log.error(`No converged plan found for task ${taskId}`);
    return false;
  }

  const synthesisResponse = JSON.parse(readFileSync(synthesisPath, "utf-8"));
  const convergedPlan = synthesisResponse.structured_output;
  if (!convergedPlan) {
    log.error(`No structured_output in synthesis for task ${taskId}`);
    return false;
  }

  const fileContext = buildTaskContext(task, projectRoot, { traceImports: true });

  // Include learnings from previous tasks
  const learnings = await buildLearningsContext(outputDir);

  const findingsSection = findingsFromDeps
    ? `\n## Findings from Exploration Tasks\nThe following issues were discovered by previous exploration tasks. Address all relevant findings:\n\n${findingsFromDeps}\n`
    : "";

  const prompt = `## Implementation Plan
${JSON.stringify(convergedPlan, null, 2)}
${learnings ? `\n${learnings}\n` : ""}${findingsSection}
## Current Source Files (for reference)
${fileContext}

## Instructions
Execute this implementation plan step by step. Create and modify all files as specified. Write all tests. Follow the plan precisely.`;

  log.info("Calling claude to implement...");

  const response = await callClaude({
    prompt,
    systemPrompt: EXECUTION_SYSTEM_PROMPT,
    model: config.models.executor,
    maxBudgetUsd: config.budget.execution_max_usd,
    dangerouslySkipPermissions: true,
    logFile: `${taskDir}/execution.log`,
  });

  await Bun.write(`${taskDir}/execution.json`, JSON.stringify(response, null, 2));

  const cost = response.total_cost_usd ?? 0;
  await recordCost(`task-${taskId}-execution`, cost);

  if (response.is_error) {
    log.error("Implementation reported error");
    return false;
  }

  log.ok(`Implementation completed ($${cost.toFixed(2)})`);
  return true;
}

export async function runPhaseBRetry(
  taskId: string,
  task: Task,
  retryNum: number,
  config: Config,
  projectRoot: string,
  outputDir: string,
): Promise<boolean> {
  const taskDir = `${outputDir}/logs/task-${taskId}`;

  log.warn(`Phase B retry ${retryNum}: Fixing verification failures for '${task.title}'`);

  // Read verification failure output
  const verifyLogPath = `${taskDir}/verify.log`;
  const verifyOutput = existsSync(verifyLogPath)
    ? readFileSync(verifyLogPath, "utf-8")
    : "No verification output available";

  // Get converged plan
  const synthesisPath = `${taskDir}/synthesis.json`;
  const synthesisResponse = JSON.parse(readFileSync(synthesisPath, "utf-8"));
  const convergedPlan = synthesisResponse.structured_output;

  const fileContext = buildTaskContext(task, projectRoot);

  const prompt = `## Original Implementation Plan
${JSON.stringify(convergedPlan, null, 2)}

## Verification Failure Output
${verifyOutput}

## Current Source Files
${fileContext}

## Instructions
Fix the verification failures shown above. Only change what is necessary to make lint, typecheck, and tests pass.`;

  log.info(`Calling claude to fix issues (retry ${retryNum})...`);

  const response = await callClaude({
    prompt,
    systemPrompt: FIX_SYSTEM_PROMPT,
    model: config.models.executor,
    maxBudgetUsd: config.budget.execution_max_usd,
    dangerouslySkipPermissions: true,
    logFile: `${taskDir}/execution-retry-${retryNum}.log`,
  });

  await Bun.write(
    `${taskDir}/execution-retry-${retryNum}.json`,
    JSON.stringify(response, null, 2),
  );

  const cost = response.total_cost_usd ?? 0;
  await recordCost(`task-${taskId}-retry-${retryNum}`, cost);

  if (response.is_error) {
    log.error(`Fix attempt ${retryNum} reported error`);
    return false;
  }

  log.ok(`Fix attempt ${retryNum} completed ($${cost.toFixed(2)})`);
  return true;
}

export async function runPhaseBRetryWithReview(
  taskId: string,
  task: Task,
  retryNum: number,
  reviewFeedback: string,
  config: Config,
  projectRoot: string,
  outputDir: string,
): Promise<boolean> {
  const taskDir = `${outputDir}/logs/task-${taskId}`;

  log.warn(`Phase B review retry ${retryNum}: Fixing review issues for '${task.title}'`);

  const synthesisPath = `${taskDir}/synthesis.json`;
  const synthesisResponse = JSON.parse(readFileSync(synthesisPath, "utf-8"));
  const convergedPlan = synthesisResponse.structured_output;

  const fileContext = buildTaskContext(task, projectRoot);

  const prompt = `## Original Implementation Plan
${JSON.stringify(convergedPlan, null, 2)}

## Code Review Feedback (FIX THESE ISSUES)
${reviewFeedback}

## Current Source Files
${fileContext}

## Instructions
Fix the issues identified in the code review. The implementation already passes lint, typecheck, and tests, but the reviewer found semantic problems. Focus on the specific issues listed in the feedback.`;

  log.info(`Calling claude to fix review issues (retry ${retryNum})...`);

  const response = await callClaude({
    prompt,
    systemPrompt: REVIEW_FIX_SYSTEM_PROMPT,
    model: config.models.executor,
    maxBudgetUsd: config.budget.execution_max_usd,
    dangerouslySkipPermissions: true,
    logFile: `${taskDir}/review-fix-${retryNum}.log`,
  });

  await Bun.write(
    `${taskDir}/review-fix-${retryNum}.json`,
    JSON.stringify(response, null, 2),
  );

  const cost = response.total_cost_usd ?? 0;
  await recordCost(`task-${taskId}-review-fix-${retryNum}`, cost);

  if (response.is_error) {
    log.error(`Review fix attempt ${retryNum} reported error`);
    return false;
  }

  log.ok(`Review fix attempt ${retryNum} completed ($${cost.toFixed(2)})`);
  return true;
}

// --- Explore task execution ---

export async function runExploreTask(
  taskId: string,
  task: Task,
  config: Config,
  projectRoot: string,
  outputDir: string,
  findingsFromDeps?: string,
): Promise<boolean> {
  const taskDir = `${outputDir}/logs/task-${taskId}`;
  mkdirSync(taskDir, { recursive: true });

  log.phase(`Explore: '${task.title}'`);

  const findingsPath = `${taskDir}/findings.md`;

  const depsContext = findingsFromDeps
    ? `\n## Findings from Previous Tasks\n${findingsFromDeps}\n`
    : "";

  const prompt = `## Task
${task.title}

## Description
${task.description}

## Acceptance Criteria
${task.acceptance_criteria.map((c) => `- ${c}`).join("\n")}

## Context Files (for reference)
${task.context_files.map((f) => `- ${f}`).join("\n")}
${depsContext}
## Instructions
Carry out the exploration/investigation described above. Use all available tools.

When you are done, write your complete findings report to: ${findingsPath}

The findings file should include:
- What you tested/investigated
- What worked correctly
- What bugs or issues you found (with details: steps to reproduce, expected vs actual behavior)
- Screenshots or evidence if available
- A structured summary at the end`;

  const timeoutMs = (config.parallelism.explore_timeout_seconds ?? 1200) * 1000;
  log.info(`Calling claude to explore... (timeout: ${timeoutMs / 1000}s)`);

  const response = await callClaude({
    prompt,
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    model: config.models.executor,
    maxBudgetUsd: config.budget.execution_max_usd,
    dangerouslySkipPermissions: true,
    logFile: `${taskDir}/execution.log`,
    timeoutMs,
  });

  await Bun.write(`${taskDir}/execution.json`, JSON.stringify(response, null, 2));

  const cost = response.total_cost_usd ?? 0;
  await recordCost(`task-${taskId}-explore`, cost);

  // Timeout but findings.md exists → treat as success
  if (response.is_error && existsSync(findingsPath)) {
    const findingsSize = readFileSync(findingsPath, "utf-8").trim().length;
    if (findingsSize > 0) {
      log.warn(`Explore task timed out or errored, but findings.md exists (${findingsSize} chars) — treating as success`);
      log.ok(`Explore completed with findings ($${cost.toFixed(2)})`);
      return true;
    }
  }

  if (response.is_error) {
    log.error("Explore task reported error");
    return false;
  }

  // If claude didn't write findings, extract from response
  if (!existsSync(findingsPath)) {
    log.warn("Findings file not created by claude, saving response as findings");
    await Bun.write(findingsPath, response.result ?? "No findings recorded.");
  }

  log.ok(`Explore completed ($${cost.toFixed(2)})`);
  return true;
}

// --- Command task execution ---

export async function runCommandTask(
  taskId: string,
  task: Task,
  config: Config,
  projectRoot: string,
  outputDir: string,
  findingsFromDeps?: string,
): Promise<boolean> {
  const taskDir = `${outputDir}/logs/task-${taskId}`;
  mkdirSync(taskDir, { recursive: true });

  log.phase(`Command: '${task.title}'`);

  const depsContext = findingsFromDeps
    ? `\n## Findings from Previous Tasks\n${findingsFromDeps}\n`
    : "";

  const prompt = `## Task
${task.title}

## Description
${task.description}

## Acceptance Criteria
${task.acceptance_criteria.map((c) => `- ${c}`).join("\n")}
${depsContext}
## Instructions
Execute the commands described above. Verify each command succeeds before proceeding. Report results clearly.`;

  const timeoutMs = (config.parallelism.command_timeout_seconds ?? 600) * 1000;
  log.info(`Calling claude to execute commands... (timeout: ${timeoutMs / 1000}s)`);

  const response = await callClaude({
    prompt,
    systemPrompt: COMMAND_SYSTEM_PROMPT,
    model: config.models.executor,
    maxBudgetUsd: config.budget.execution_max_usd,
    dangerouslySkipPermissions: true,
    logFile: `${taskDir}/execution.log`,
    timeoutMs,
  });

  await Bun.write(`${taskDir}/execution.json`, JSON.stringify(response, null, 2));

  const cost = response.total_cost_usd ?? 0;
  await recordCost(`task-${taskId}-command`, cost);

  if (response.is_error) {
    log.error("Command task reported error");
    return false;
  }

  log.ok(`Command completed ($${cost.toFixed(2)})`);
  return true;
}

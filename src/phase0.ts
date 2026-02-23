import { mkdirSync } from "fs";
import { log } from "./logger";
import { callClaude, getStructuredOutput } from "./claude";
import { buildContext } from "./context";
import { generateProjectSummary } from "./summarize";
import { recordCost } from "./budget";
import { checkNoCircularDeps } from "./state";
import type { Config, Task, TaskQueue } from "./types";

const RESEARCH_SYSTEM_PROMPT = `You are a research assistant preparing context for a software development task planner.

Your job is to investigate the user's instructions and gather all information needed to plan the implementation. The instructions may reference external resources such as:
- GitHub/GitLab issues (e.g., "Issue 123", "issue #456")
- Pull requests, tickets, or other tracking systems
- Documentation URLs or external references

Use the tools available to you to:
1. Fetch and read any referenced issues, tickets, or external resources
2. Summarize the key requirements, acceptance criteria, and technical details found
3. Note any relevant discussion, comments, or linked resources

Output a clear, comprehensive summary of what needs to be done based on your research. Include all technical details from the referenced resources. Write in the same language as the original instructions.`;

const RESEARCH_TIMEOUT_MS = 180_000; // 3 minutes

/**
 * Research instructions by fetching external references (issues, URLs, etc.)
 * using tools. Runs before Phase 0 to enrich instructions with real content.
 */
export async function researchInstructions(
  instructions: string,
  config: Config,
  outputDir: string,
  projectRoot?: string,
): Promise<string> {
  log.phase("Phase 0 (prep): Researching instructions");
  mkdirSync(`${outputDir}/logs/phase0`, { recursive: true });

  const prompt = `## Instructions to Research\n${instructions}\n\nResearch the above instructions. Fetch any referenced issues, tickets, or external resources. Then output a comprehensive summary of what needs to be done.`;

  log.info("Calling claude to research instructions...");

  const response = await callClaude({
    prompt,
    systemPrompt: RESEARCH_SYSTEM_PROMPT,
    model: "sonnet",
    maxBudgetUsd: config.budget.plan_max_usd,
    dangerouslySkipPermissions: true,
    timeoutMs: RESEARCH_TIMEOUT_MS,
    logFile: `${outputDir}/logs/phase0/research.log`,
    cwd: projectRoot,
  });

  await Bun.write(`${outputDir}/logs/phase0/research_output.json`, JSON.stringify(response, null, 2));
  await recordCost("phase0-research", response.total_cost_usd ?? 0);

  if (response.is_error || !response.result) {
    log.warn(`Research step failed or empty: ${response.result ?? "no result"}. Falling back to original instructions.`);
    return instructions;
  }

  const result = response.result.trim();
  log.ok(`Research complete (${result.length} chars)`);

  // Return enriched instructions: original + research findings
  return `${instructions}\n\n## Research Findings\nThe following information was gathered from referenced resources:\n\n${result}`;
}

const SYSTEM_PROMPT = `You are a senior software architect analyzing a codebase to break down a goal into actionable tasks.

Rules:
- Break the goal into an ordered list of concrete, atomic tasks
- Each task must be completable in a single focused session
- Tasks must be ordered so dependencies come first
- context_files should list the specific files each task needs to read or modify
- depends_on references other task IDs that must complete before this one
- acceptance_criteria should be testable conditions (e.g., "function X returns correct output for input Y")
- Task IDs must follow the pattern task-001, task-002, etc.
- Aim for 5-7 tasks. Merge closely related changes into a single task rather than splitting them (e.g., "create utility + endpoint" is one task, not two). Each task should represent a meaningful, independently verifiable unit of work. Only exceed 7 tasks for genuinely large, multi-component features.

Task types (set the "type" field for each task):
- "code": Write or modify source code. This is the default for implementation tasks.
- "explore": Investigate, test, or gather information. Use this for exploratory testing (e.g., using a browser to find bugs), research, or any task whose primary output is a report/findings rather than code changes. The executor has access to all user-configured tools including browser automation.
- "command": Execute a specific shell command (deploy, migrate, run a script, etc). Use when the task is primarily about running a command and verifying its success.

Important: Choose the right type based on the task's PRIMARY activity. A task that tests a website to find bugs is "explore", not "code". A task that deploys code is "command", not "code". A task that fixes bugs found by a previous explore task is "code".

Do NOT create a final "run all tests" or "verify everything works" command task. The orchestrator already runs verification (typecheck, lint, test, format) automatically after every code task. A redundant test-run task at the end wastes budget and time.

Complexity classification (determines how many parallel competing implementations will run — use lower complexity to save budget):
- trivial: Scaffolding, boilerplate, config changes, or single-file edits with a clear pattern. Even if many files are generated, if the task is following a well-known template (e.g., "npm init + install deps + create config files"), it is trivial.
- standard: Moderate logic across 2-5 files, CRUD operations, or tasks where the approach is mostly determined by existing patterns/conventions. Multiple valid approaches exist but differences would be minor.
- complex: Significant architectural decisions, novel design patterns, or tasks where multiple fundamentally different approaches could be taken. Reserve this for tasks that genuinely benefit from exploring competing strategies.

IMPORTANT: For greenfield projects, "project setup/initialization" is always trivial regardless of file count. "Add CRUD API routes" is standard. Only tasks requiring genuine design decisions (dashboard layout strategy, complex business logic, real-time features) should be complex.`;

export async function generateTaskQueue(
  goal: string,
  contextPaths: string[],
  config: Config,
  projectRoot: string,
  outputDir: string,
  templatesDir: string,
  instructions?: string,
): Promise<TaskQueue> {
  log.phase("Phase 0: Generating task queue");
  mkdirSync(`${outputDir}/logs/phase0`, { recursive: true });

  // Generate project structure summary
  log.info("Generating project structure summary...");
  const projectSummary = await generateProjectSummary(projectRoot);
  await Bun.write(`${outputDir}/logs/phase0/project_summary.md`, projectSummary);

  // Context strategy: if research findings are present, they already contain
  // relevant file paths and technical details — skip the full codebase context
  // to keep the prompt small. Otherwise, build full context as before.
  const hasResearchFindings = instructions?.includes("## Research Findings") ?? false;

  let contextContent: string;
  if (hasResearchFindings) {
    log.info("Research findings available — using lightweight context (project summary only)");
    contextContent = "";
  } else {
    contextContent = await buildContext(contextPaths, projectRoot);
    if (!contextContent) {
      throw new Error("No context could be built from provided paths");
    }
  }

  const schema = await Bun.file(`${templatesDir}/task_queue.schema.json`).json();

  const instructionsSection = instructions
    ? `\n\n## User Instructions\nThe user has provided the following specific instructions. Prioritize these when generating the task queue:\n\n${instructions}`
    : "";

  const contextSection = contextContent
    ? `\n\n## Codebase Context\n${contextContent}`
    : "";

  const prompt = `## Goal\n${goal}${instructionsSection}\n\n${projectSummary}${contextSection}\n\nAnalyze the codebase and the goal. Break the goal into a structured list of implementation tasks.`;

  log.info("Calling claude to generate task queue...");

  const response = await callClaude({
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    model: config.models.planner,
    maxBudgetUsd: config.budget.per_task_max_usd,
    jsonSchema: schema,
    tools: "",
    logFile: `${outputDir}/logs/phase0/generation.log`,
  });

  await Bun.write(`${outputDir}/logs/phase0/raw_output.json`, JSON.stringify(response, null, 2));
  await recordCost("phase0-generation", response.total_cost_usd ?? 0);

  const structured = getStructuredOutput<{ tasks: Task[] }>(response);
  if (!structured?.tasks) {
    throw new Error("Failed to get structured output from claude. Check logs/phase0/raw_output.json");
  }

  const taskQueue: TaskQueue = {
    goal,
    ...(instructions ? { instructions } : {}),
    generated_at: new Date().toISOString(),
    tasks: structured.tasks,
  };

  // Validate
  const errors = validateTaskQueue(taskQueue.tasks);
  if (errors.length > 0) {
    log.warn(`Task queue validation failed: ${errors.join(", ")}`);
    log.info("Attempting regeneration...");

    const retried = await regenerateTaskQueue(goal, contextContent, taskQueue, schema, config, outputDir);
    if (retried) {
      taskQueue.tasks = retried.tasks;
    } else {
      throw new Error(`Task queue validation failed: ${errors.join(", ")}`);
    }
  }

  await Bun.write(`${outputDir}/tasks.json`, JSON.stringify(taskQueue, null, 2));

  log.ok(`Generated ${taskQueue.tasks.length} tasks`);
  console.log("");
  log.info("Task queue:");
  for (const task of taskQueue.tasks) {
    const tag = task.estimated_complexity.toUpperCase().slice(0, 3);
    const typeTag = task.type && task.type !== "code" ? ` (${task.type})` : "";
    log.info(`  [${tag}] ${task.id}: ${task.title}${typeTag}`);
  }
  console.log("");

  return taskQueue;
}

const REFINE_SYSTEM_PROMPT = `You are a senior software architect refining an existing task queue based on user instructions.

Rules:
- Apply the user's modification instructions to the existing task queue
- Maintain all required fields for each task: id, title, description, depends_on, context_files, acceptance_criteria, estimated_complexity
- When adding new tasks, use the next available task ID (task-NNN pattern)
- When removing tasks, also remove references to them from other tasks' depends_on
- When reordering, update depends_on references accordingly
- Preserve tasks that the user didn't mention (unless the instruction implies otherwise)
- Keep the same JSON schema structure`;

export async function refineTaskQueue(
  instruction: string,
  currentTaskQueue: TaskQueue,
  config: Config,
  outputDir: string,
  templatesDir: string,
): Promise<TaskQueue> {
  log.phase("Refining task queue");

  const schema = await Bun.file(`${templatesDir}/task_queue.schema.json`).json();

  const prompt = `## Current Task Queue
${JSON.stringify(currentTaskQueue, null, 2)}

## Modification Instructions
${instruction}

## Rules
- Apply the modifications described above to the current task queue
- Return the complete modified task queue (all tasks, not just changed ones)
- Maintain valid depends_on references (remove references to deleted tasks)
- Keep unchanged tasks as-is`;

  log.info("Calling claude to refine task queue...");

  const response = await callClaude({
    prompt,
    systemPrompt: REFINE_SYSTEM_PROMPT,
    model: config.models.planner,
    maxBudgetUsd: config.budget.per_task_max_usd,
    jsonSchema: schema,
    tools: "",
    logFile: `${outputDir}/logs/phase0/refine.log`,
  });

  await Bun.write(`${outputDir}/logs/phase0/refine_output.json`, JSON.stringify(response, null, 2));
  await recordCost("phase0-refine", response.total_cost_usd ?? 0);

  const structured = getStructuredOutput<{ tasks: Task[] }>(response);
  if (!structured?.tasks) {
    throw new Error("Failed to get structured output from claude during refine. Check logs/phase0/refine_output.json");
  }

  const refined: TaskQueue = {
    goal: currentTaskQueue.goal,
    generated_at: currentTaskQueue.generated_at,
    tasks: structured.tasks,
  };

  // Validate
  const errors = validateTaskQueue(refined.tasks);
  if (errors.length > 0) {
    throw new Error(`Refined task queue validation failed: ${errors.join(", ")}`);
  }

  return refined;
}

function validateTaskQueue(tasks: Task[]): string[] {
  const errors: string[] = [];

  if (!tasks || tasks.length === 0) {
    errors.push("No tasks generated");
    return errors;
  }

  for (const task of tasks) {
    if (!task.id || !task.title || !task.description) {
      errors.push(`Task missing required fields: ${task.id ?? "unknown"}`);
    }
    if (task.context_files && task.context_files.length > 7) {
      // Just a warning, not a hard error
      log.warn(`Task ${task.id} references ${task.context_files.length} files (>7)`);
    }
  }

  // Check dependency references
  const allIds = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    for (const dep of task.depends_on ?? []) {
      if (!allIds.has(dep)) {
        errors.push(`Task ${task.id} references non-existent dependency: ${dep}`);
      }
    }
  }

  // Check circular deps
  if (!checkNoCircularDeps(tasks)) {
    errors.push("Circular dependencies detected");
  }

  return errors;
}

async function regenerateTaskQueue(
  goal: string,
  contextContent: string,
  prevOutput: TaskQueue,
  schema: object,
  config: Config,
  outputDir: string,
): Promise<{ tasks: Task[] } | null> {
  const contextSection = contextContent
    ? `\n\n## Codebase Context\n${contextContent}`
    : "";

  const prompt = `## Goal\n${goal}${contextSection}\n\n## Previous Attempt (had validation errors)\n${JSON.stringify(prevOutput, null, 2)}\n\nThe previous task queue had validation issues. Please regenerate with fixes:\n- Ensure all tasks have id, title, description, depends_on, context_files, acceptance_criteria, estimated_complexity\n- Ensure dependency references only use valid task IDs\n- Ensure no circular dependencies\n- Each task should affect 1-7 files`;

  const response = await callClaude({
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    model: config.models.planner,
    maxBudgetUsd: config.budget.per_task_max_usd,
    jsonSchema: schema,
    tools: "",
    logFile: `${outputDir}/logs/phase0/regeneration.log`,
  });

  await recordCost("phase0-regeneration", response.total_cost_usd ?? 0);

  const structured = getStructuredOutput<{ tasks: Task[] }>(response);
  if (!structured?.tasks) return null;

  const errors = validateTaskQueue(structured.tasks);
  if (errors.length > 0) {
    log.error(`Task queue still invalid after retry: ${errors.join(", ")}`);
    return null;
  }

  return structured;
}

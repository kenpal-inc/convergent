import { mkdirSync, readFileSync, existsSync } from "fs";
import { log } from "./logger";
import { callClaude, getStructuredOutput } from "./claude";
import { buildTaskContext } from "./context";
import { recordCost } from "./budget";
import { recordConvergenceMetrics } from "./state";
import type { Config, ConvergedPlan, ConvergenceMetrics, PersonaMap, PlanOutput, Task } from "./types";

const SYNTHESIS_SYSTEM_PROMPT = `You are a senior technical lead performing plan synthesis through convergent evolution.

You have received implementation plans from multiple engineering personas, each with different priorities (e.g., conservative, minimalist, TDD, performance, UX, security, pragmatic).

Your job:
1. CONVERGENT DECISIONS: Identify elements most personas agree on. These are high-confidence decisions that should be adopted.
2. RESOLVED DIVERGENCES: Where personas disagree, pick the approach that best balances correctness, simplicity, and robustness. Explain your rationale.
3. UNIQUE INSIGHTS: Find valuable ideas from individual personas that others missed. Adopt them if they add clear value without unnecessary complexity.
4. IMPLEMENTATION STEPS: Produce a single, definitive, step-by-step implementation plan that a developer can follow without ambiguity.

The converged plan must be specific enough to implement directly:
- Exact file paths (relative to project root)
- Function/type signatures where relevant
- Import statements if adding new dependencies
- Clear ordering of changes
- Test cases with descriptions`;

export async function runPhaseA(
  taskId: string,
  task: Task,
  config: Config,
  projectRoot: string,
  outputDir: string,
  libDir: string,
  templatesDir: string,
): Promise<boolean> {
  const taskDir = `${outputDir}/logs/task-${taskId}`;
  mkdirSync(taskDir, { recursive: true });

  const complexity = task.estimated_complexity;
  log.phase(`Phase A: Convergent evolution for '${task.title}' [${complexity}]`);

  // Select personas based on complexity
  const personaIds = config.personas[complexity] ?? [];

  if (personaIds.length === 0) {
    log.info(`No personas for complexity '${complexity}', creating direct plan`);
    return createDirectPlan(taskId, task, config, projectRoot, outputDir, libDir, templatesDir);
  }

  // Load persona definitions
  const personas: PersonaMap = JSON.parse(
    readFileSync(`${libDir}/personas.json`, "utf-8"),
  );

  // Build context (with import graph tracing)
  const fileContext = buildTaskContext(task, projectRoot, { traceImports: true });
  const tasksContext = readFileSync(`${outputDir}/tasks.json`, "utf-8");
  const acceptanceCriteria = (task.acceptance_criteria ?? []).map((c) => `- ${c}`).join("\n");
  const planSchema = await Bun.file(`${templatesDir}/plan_output.schema.json`).json();

  // Load project summary if available (generated in Phase 0)
  const summaryPath = `${outputDir}/logs/phase0/project_summary.md`;
  const projectSummary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf-8") : "";

  const userPrompt = `## Task
ID: ${taskId}
Title: ${task.title}
Description: ${task.description}

## Acceptance Criteria
${acceptanceCriteria}
${projectSummary ? `\n${projectSummary}\n` : ""}
## Full Task Queue (for context on how this task fits into the larger plan)
${tasksContext}

## Relevant Source Files (starting point — explore further as needed)
${fileContext}

## Instructions
You have tools to explore the codebase (Read, Glob, Grep). Use them to:
1. Verify the relevant files and understand their current state
2. Discover additional files, patterns, or conventions that inform your plan
3. Check for existing implementations of similar features

Then produce a detailed implementation plan for this specific task. Include:
1. Files to create or modify (with exact paths relative to project root)
2. For each file: the specific changes, new functions/types, and their signatures
3. Any new dependencies needed
4. Test cases that should be written
5. Potential risks or edge cases

Be specific and concrete. Someone should be able to implement your plan without ambiguity.`;

  const timeoutMs = config.parallelism.persona_timeout_seconds * 1000;

  log.info(`Launching ${personaIds.length} personas in parallel...`);

  const minRequired = personaIds.length <= 3 ? 2 : 3;
  const successfulPlans: { personaId: string; plan: PlanOutput }[] = [];
  let succeeded = 0;
  let failed = 0;

  // Stagger persona launches by 2s to avoid concurrent spawn contention.
  //
  // Phase A has task-level parallelism (Promise.all across batch) multiplied by
  // persona-level parallelism (Promise.allSettled within each task). Without stagger,
  // all processes start simultaneously, causing resource contention.
  // Buffer.from() for stdin (in claude.ts) prevents file-system race conditions
  // but does NOT eliminate the need for stagger — both are required.
  // Phase C (review) does NOT need stagger: only 3 processes, no task-level parallelism.
  const STAGGER_MS = 2_000;

  const personaPromises = personaIds.map(async (personaId, idx) => {
    const persona = personas[personaId];
    if (!persona) {
      log.warn(`Persona '${personaId}' not found in personas.json, skipping`);
      return null;
    }

    // Stagger launches: first persona starts immediately, others wait
    if (idx > 0) {
      await Bun.sleep(idx * STAGGER_MS);
    }

    const explorationGuidance = persona.exploration_guidance
      ? `\n\nYou have Read, Glob, and Grep tools to explore the codebase. ${persona.exploration_guidance}`
      : "";
    const fullSystemPrompt = `${persona.system_prompt}\n\nYou are analyzing a software engineering task as the '${persona.name}' persona. Apply your specific expertise and priorities when designing the implementation plan. Be concrete about file paths, function signatures, and code structure.${explorationGuidance}`;

    log.info(`  Starting persona: ${personaId} (${persona.name})`);

    const response = await callClaude({
      prompt: userPrompt,
      systemPrompt: fullSystemPrompt,
      model: config.models.persona,
      maxBudgetUsd: config.budget.per_persona_max_usd,
      jsonSchema: planSchema,
      tools: "Read,Glob,Grep",
      timeoutMs,
      logFile: `${taskDir}/persona-${personaId}.log`,
    });

    await Bun.write(
      `${taskDir}/persona-${personaId}.json`,
      JSON.stringify(response, null, 2),
    );

    return { personaId, response };
  });

  // Wait for all personas to complete (matching Phase C's proven pattern)
  const results = await Promise.allSettled(personaPromises);

  for (const result of results) {
    if (result.status === "rejected") {
      failed++;
      log.warn(`  Persona failed: ${result.reason}`);
      continue;
    }

    const value = result.value;
    if (!value) {
      failed++;
      continue;
    }

    const { personaId, response } = value;
    const plan = getStructuredOutput<PlanOutput>(response);
    if (plan) {
      succeeded++;
      const cost = response.total_cost_usd ?? 0;
      await recordCost(`task-${taskId}-persona-${personaId}`, cost);
      log.ok(`  Persona ${personaId} completed ($${cost.toFixed(2)})`);
      successfulPlans.push({ personaId, plan });
    } else {
      failed++;
      log.warn(`  Persona ${personaId} returned no structured output`);
    }
  }

  log.info(`Personas: ${succeeded} succeeded, ${failed} failed`);

  // --- Retry failed personas once if we don't have enough ---
  if (succeeded < minRequired && failed > 0) {
    const failedPersonaIds = personaIds.filter(
      pid => !successfulPlans.some(sp => sp.personaId === pid),
    );
    const neededMore = minRequired - succeeded;
    const retryIds = failedPersonaIds.slice(0, neededMore);

    log.info(`Retrying ${retryIds.length} failed persona(s): ${retryIds.join(", ")}`);

    for (const personaId of retryIds) {
      const persona = personas[personaId];
      if (!persona) continue;

      const explorationGuidance = persona.exploration_guidance
        ? `\n\nYou have Read, Glob, and Grep tools to explore the codebase. ${persona.exploration_guidance}`
        : "";
      const fullSystemPrompt = `${persona.system_prompt}\n\nYou are analyzing a software engineering task as the '${persona.name}' persona. Apply your specific expertise and priorities when designing the implementation plan. Be concrete about file paths, function signatures, and code structure.${explorationGuidance}`;

      log.info(`  Retrying persona: ${personaId} (${persona.name})`);

      try {
        const response = await callClaude({
          prompt: userPrompt,
          systemPrompt: fullSystemPrompt,
          model: config.models.persona,
          maxBudgetUsd: config.budget.per_persona_max_usd,
          jsonSchema: planSchema,
          tools: "Read,Glob,Grep",
          timeoutMs,
          logFile: `${taskDir}/persona-${personaId}-retry.log`,
        });

        await Bun.write(
          `${taskDir}/persona-${personaId}-retry.json`,
          JSON.stringify(response, null, 2),
        );

        const plan = getStructuredOutput<PlanOutput>(response);
        if (plan) {
          succeeded++;
          const cost = response.total_cost_usd ?? 0;
          await recordCost(`task-${taskId}-persona-${personaId}-retry`, cost);
          log.ok(`  Persona ${personaId} retry succeeded ($${cost.toFixed(2)})`);
          successfulPlans.push({ personaId, plan });
        } else {
          log.warn(`  Persona ${personaId} retry still returned no structured output`);
        }
      } catch (retryErr) {
        log.warn(`  Persona ${personaId} retry failed: ${retryErr}`);
      }

      if (succeeded >= minRequired) break;
    }

    log.info(`After retries: ${succeeded} succeeded`);
  }

  // --- Fallback: if still insufficient, use single plan or direct plan ---
  if (succeeded < minRequired) {
    if (succeeded >= 1) {
      // Use the single successful plan directly (skip synthesis)
      log.warn(`Only ${succeeded} persona(s) succeeded, using single plan directly (skipping synthesis)`);
      const singlePlan = successfulPlans[0];

      // Convert PlanOutput to ConvergedPlan format for Phase B
      const convergedPlan: ConvergedPlan = {
        convergent_decisions: [singlePlan.plan.approach_summary],
        resolved_divergences: [],
        unique_insights_adopted: [],
        implementation_steps: (singlePlan.plan.files ?? []).map((f, idx) => ({
          order: idx + 1,
          description: f.description,
          file_path: f.path,
          action: f.action,
          detailed_instructions: (f.key_changes ?? []).join("\n") || f.description,
        })),
        test_plan: (singlePlan.plan.test_cases ?? [])
          .filter(tc => tc.file)
          .map(tc => ({
            file_path: tc.file!,
            test_cases: [tc.description],
          })),
      };

      const taskDir2 = `${outputDir}/logs/task-${taskId}`;
      const fakeResponse = { structured_output: convergedPlan, total_cost_usd: 0 };
      await Bun.write(`${taskDir2}/synthesis.json`, JSON.stringify(fakeResponse, null, 2));
      log.ok(`Single-plan fallback saved as synthesis for ${taskId}`);
      try {
        await recordConvergenceMetrics(taskId, {
          persona_count: personaIds.length, successful_count: succeeded, file_consensus: 0,
          synthesis_mode: "single_plan_fallback",
          convergent_decisions_count: 1, divergences_resolved_count: 0, unique_insights_count: 0,
        });
      } catch { /* non-fatal */ }
      return true;
    }

    // All personas failed — fallback to direct plan
    log.warn(`All personas failed, falling back to direct plan`);
    return createDirectPlan(taskId, task, config, projectRoot, outputDir, libDir, templatesDir);
  }

  // Synthesis
  const fileConsensus = checkFileConsensus(successfulPlans);
  const synthesisOk = await runSynthesis(taskId, task, successfulPlans, config, outputDir, templatesDir);

  if (synthesisOk) {
    try {
      const synthPath = `${taskDir}/synthesis.json`;
      const synthData = JSON.parse(readFileSync(synthPath, "utf-8"));
      const plan = synthData.structured_output as ConvergedPlan | null;
      await recordConvergenceMetrics(taskId, {
        persona_count: personaIds.length, successful_count: succeeded, file_consensus: fileConsensus,
        synthesis_mode: "converged",
        convergent_decisions_count: plan?.convergent_decisions?.length ?? 0,
        divergences_resolved_count: plan?.resolved_divergences?.length ?? 0,
        unique_insights_count: plan?.unique_insights_adopted?.length ?? 0,
      });
    } catch { /* non-fatal */ }
  }

  return synthesisOk;
}

/**
 * Measure file-level consensus among plans: what fraction of files
 * appear in more than half of the plans.
 * Returns 0..1 where 1 = all plans agree on exactly the same files.
 */
function checkFileConsensus(plans: { personaId: string; plan: PlanOutput }[]): number {
  if (plans.length < 2) return 0;

  // Count how many plans mention each file
  const fileCounts = new Map<string, number>();
  for (const { plan } of plans) {
    for (const file of plan.files ?? []) {
      const path = file.path.toLowerCase();
      fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1);
    }
  }

  if (fileCounts.size === 0) return 0;

  const threshold = plans.length / 2;
  let consensusFiles = 0;
  for (const count of fileCounts.values()) {
    if (count > threshold) consensusFiles++;
  }

  return consensusFiles / fileCounts.size;
}

async function runSynthesis(
  taskId: string,
  task: Task,
  plans: { personaId: string; plan: PlanOutput }[],
  config: Config,
  outputDir: string,
  templatesDir: string,
): Promise<boolean> {
  const taskDir = `${outputDir}/logs/task-${taskId}`;

  log.info("Running synthesis...");

  const allPlans = plans
    .map((p) => `\n=== ${p.personaId} Persona Plan ===\n${JSON.stringify(p.plan, null, 2)}`)
    .join("\n\n");

  const convergedSchema = await Bun.file(`${templatesDir}/converged_plan.schema.json`).json();

  const prompt = `## Original Task
Title: ${task.title}
Description: ${task.description}

## Plans from ${plans.length} Personas
${allPlans}

## Instructions
Synthesize these plans into a single optimal implementation plan. Focus on what the personas converge on, resolve disagreements with clear rationale, and adopt unique insights that add value.`;

  const response = await callClaude({
    prompt,
    systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
    model: config.models.synthesizer,
    maxBudgetUsd: config.budget.synthesis_max_usd,
    jsonSchema: convergedSchema,
    tools: "",
    logFile: `${taskDir}/synthesis.log`,
  });

  await Bun.write(`${taskDir}/synthesis.json`, JSON.stringify(response, null, 2));

  const convergedPlan = getStructuredOutput<ConvergedPlan>(response);
  if (!convergedPlan) {
    log.error("Synthesis failed to produce structured output");
    return false;
  }

  const cost = response.total_cost_usd ?? 0;
  await recordCost(`task-${taskId}-synthesis`, cost);

  log.ok(`Synthesis completed ($${cost.toFixed(2)})`);
  log.info(`  Convergent: ${convergedPlan.convergent_decisions?.length ?? 0}, Divergences resolved: ${convergedPlan.resolved_divergences?.length ?? 0}, Unique insights: ${convergedPlan.unique_insights_adopted?.length ?? 0}`);
  log.info(`  Implementation steps: ${convergedPlan.implementation_steps?.length ?? 0}`);

  return true;
}

async function createDirectPlan(
  taskId: string,
  task: Task,
  config: Config,
  projectRoot: string,
  outputDir: string,
  _libDir: string,
  templatesDir: string,
): Promise<boolean> {
  const taskDir = `${outputDir}/logs/task-${taskId}`;
  mkdirSync(taskDir, { recursive: true });

  log.info("Creating direct plan (no persona synthesis needed)");

  const fileContext = buildTaskContext(task, projectRoot, { traceImports: true });
  const acceptanceCriteria = (task.acceptance_criteria ?? []).map((c) => `- ${c}`).join("\n");
  const convergedSchema = await Bun.file(`${templatesDir}/converged_plan.schema.json`).json();

  const prompt = `## Task
Title: ${task.title}
Description: ${task.description}

## Acceptance Criteria
${acceptanceCriteria}

## Relevant Source Files
${fileContext}

Create a step-by-step implementation plan. For convergent_decisions, list the key design choices. Leave resolved_divergences empty. Leave unique_insights_adopted empty.`;

  const response = await callClaude({
    prompt,
    systemPrompt: "You are an experienced software developer. Create a clear, step-by-step implementation plan for the given task. Be specific about file paths, code changes, and test cases.",
    model: config.models.persona,
    maxBudgetUsd: config.budget.per_persona_max_usd,
    jsonSchema: convergedSchema,
    tools: "",
    logFile: `${taskDir}/synthesis.log`,
  });

  await Bun.write(`${taskDir}/synthesis.json`, JSON.stringify(response, null, 2));

  const plan = getStructuredOutput<ConvergedPlan>(response);
  if (!plan) {
    log.error("Direct plan generation failed");
    return false;
  }

  const cost = response.total_cost_usd ?? 0;
  await recordCost(`task-${taskId}-direct-plan`, cost);
  log.ok(`Direct plan generated ($${cost.toFixed(2)})`);

  try {
    await recordConvergenceMetrics(taskId, {
      persona_count: 0, successful_count: 0, file_consensus: 0,
      synthesis_mode: "direct_plan",
      convergent_decisions_count: 0, divergences_resolved_count: 0, unique_insights_count: 0,
    });
  } catch { /* non-fatal */ }

  return true;
}

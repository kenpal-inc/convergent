// --- Configuration ---

export interface Config {
  models: {
    planner: string;
    persona: string;
    synthesizer: string;
    executor: string;
  };
  budget: {
    total_max_usd: number;
    per_task_max_usd: number;
    per_persona_max_usd: number;
    synthesis_max_usd: number;
    execution_max_usd: number;
    review_max_usd: number;
    per_review_persona_max_usd: number;
  };
  parallelism: {
    persona_timeout_seconds: number;
    max_parallel_tasks?: number;
    explore_timeout_seconds?: number;
    command_timeout_seconds?: number;
  };
  verification: {
    commands: string[];
    max_retries: number;
    timeout_seconds?: number;
    parallel?: boolean;
  };
  review: {
    enabled: boolean;
    max_retries: number;
    personas: string[];
  };
  personas: {
    trivial: string[];
    standard: string[];
    complex: string[];
  };
  git: {
    auto_commit: boolean;
    create_branch: boolean;
    create_pr: boolean;
  };
}

// --- Task Queue (Phase 0 output) ---

export type TaskType = "code" | "explore" | "command";

export interface Task {
  id: string;
  title: string;
  type?: TaskType;
  description: string;
  depends_on: string[];
  context_files: string[];
  acceptance_criteria: string[];
  estimated_complexity: "trivial" | "standard" | "complex";
}

export interface TaskQueue {
  goal: string;
  instructions?: string;
  generated_at: string;
  tasks: Task[];
}

// --- State ---

export type TaskStatusValue =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked";

export type TaskPhase = "A" | "B" | "verify" | "review" | "commit";

export interface ConvergenceMetrics {
  persona_count: number;
  successful_count: number;
  file_consensus: number;
  synthesis_mode: "converged" | "single_plan_fallback" | "direct_plan";
  convergent_decisions_count: number;
  divergences_resolved_count: number;
  unique_insights_count: number;
}

export interface TaskStatus {
  status: TaskStatusValue;
  phase?: TaskPhase;
  completed_at?: string;
  convergence_metrics?: ConvergenceMetrics;
}

export interface State {
  current_task_index: number;
  tasks_status: Record<string, TaskStatus>;
  total_cost_usd: number;
  consecutive_failures: number;
  started_at: string;
  last_updated: string;
  branch_name?: string;
  pr_url?: string;
}

// --- Budget ---

export interface BudgetEntry {
  label: string;
  cost_usd: number;
  timestamp: string;
}

export interface Budget {
  entries: BudgetEntry[];
  total_usd: number;
}

// --- Persona ---

export interface Persona {
  name: string;
  system_prompt: string;
  exploration_guidance?: string;
}

export type PersonaMap = Record<string, Persona>;

// --- Claude CLI Response ---

export interface ClaudeResponse {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  total_cost_usd: number;
  structured_output?: unknown;
}

// --- Plan Output (individual persona) ---

export interface PlanFile {
  path: string;
  action: "create" | "modify" | "delete";
  description: string;
  key_changes?: string[];
}

export interface PlanTestCase {
  description: string;
  file?: string;
  type?: "unit" | "integration" | "e2e";
}

export interface PlanOutput {
  approach_summary: string;
  files: PlanFile[];
  new_dependencies?: string[];
  test_cases: PlanTestCase[];
  risks?: string[];
}

// --- Converged Plan (synthesis output) ---

export interface ResolvedDivergence {
  topic: string;
  chosen_approach: string;
  rationale: string;
}

export interface ImplementationStep {
  order: number;
  description: string;
  file_path: string;
  action: "create" | "modify" | "delete";
  detailed_instructions: string;
}

export interface TestPlanEntry {
  file_path: string;
  test_cases: string[];
}

export interface ConvergedPlan {
  convergent_decisions: string[];
  resolved_divergences?: ResolvedDivergence[];
  unique_insights_adopted?: string[];
  implementation_steps: ImplementationStep[];
  test_plan: TestPlanEntry[];
}

// --- Review Result (Phase C output) ---

export interface ReviewPlanCompliance {
  compliant: boolean;
  missing_steps: string[];
  extra_changes: string[];
  notes?: string;
}

export interface ReviewCriterionCheck {
  criterion: string;
  satisfied: boolean;
  evidence: string;
}

export interface ReviewIssue {
  severity: "error" | "warning" | "info";
  category:
    | "plan_deviation"
    | "security"
    | "error_handling"
    | "pattern_violation"
    | "unnecessary_change"
    | "missing_implementation"
    | "other";
  file_path?: string;
  description: string;
  suggestion?: string;
}

export interface ReviewResult {
  verdict: "approved" | "changes_requested" | "error";
  summary: string;
  plan_compliance: ReviewPlanCompliance;
  acceptance_criteria_check: ReviewCriterionCheck[];
  issues: ReviewIssue[];
}

// --- Claude Call Options ---

export interface ClaudeCallOptions {
  prompt: string;
  systemPrompt: string;
  model: string;
  maxBudgetUsd: number;
  jsonSchema?: object;
  tools?: string;
  dangerouslySkipPermissions?: boolean;
  timeoutMs?: number;
  logFile?: string;
}

// --- CLI Args ---

export interface CliArgs {
  context: string[];
  goal: string;
  instructions?: string;
  resume: boolean;
  review: boolean;
  dryRun: boolean;
  refine?: string;
  retryFailed: boolean;
  configPath?: string;
  maxBudget?: number;
  model?: string;
  verbose: boolean;
}

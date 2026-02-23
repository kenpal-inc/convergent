// --- Configuration ---

export interface Config {
  models: {
    planner: string;
    executor: string;
  };
  budget: {
    total_max_usd: number;
    per_task_max_usd: number;
    plan_max_usd: number;
    execution_max_usd: number;
    review_max_usd: number;
    per_review_persona_max_usd: number;
  };
  parallelism: {
    tournament_timeout_seconds: number;
    explore_timeout_seconds?: number;
    command_timeout_seconds?: number;
  };
  tournament: {
    competitors: number;
    strategies: string[];
    /** Minimum convergence score (0-1) required to attempt synthesis. Default set in config.default.json (task-003). */
    convergence_threshold?: number;
  };
  verification: {
    auto_detect: boolean;
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

export type TaskPhase = "T" | "B" | "verify" | "review" | "commit";

export interface TournamentMetrics {
  competitors_count: number;
  implementations_succeeded: number;
  verifications_passed: number;
  winner_strategy: string;
  winner_score: number;
  score_spread: number;
  convergence_ratio?: number; // 0-1: how similar successful implementations are
  diff_lines_winner?: number; // lines changed by winner (fewer = cleaner)
  /** Whether convergence synthesis was attempted in this tournament. */
  synthesis_attempted?: boolean;
  /** Whether convergence synthesis succeeded in this tournament. */
  synthesis_succeeded?: boolean;
}

export interface TaskStatus {
  status: TaskStatusValue;
  phase?: TaskPhase;
  completed_at?: string;
  tournament_metrics?: TournamentMetrics;
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

// --- Competitor (tournament) ---

export interface Competitor {
  name: string;
  system_prompt: string;
}

export type CompetitorMap = Record<string, Competitor>;

// --- Review Persona ---

export interface ReviewPersona {
  name: string;
  system_prompt: string;
}

export type ReviewPersonaMap = Record<string, ReviewPersona>;

// --- Tournament Result ---

export interface CompetitorResult {
  id: number;
  strategy: string;
  implementationOk: boolean;
  verificationScore: number;
  verificationDetails: { name: string; passed: boolean; weight: number }[];
  cost: number;
}

export interface ConvergenceAnalysis {
  convergence_ratio: number; // 0-1: proportion of files changed by all successful competitors
  common_files: string[]; // files changed by every successful competitor
  divergent_files: string[]; // files changed by only some competitors
  diff_lines: Record<number, number>; // competitor id → diff line count
}

/** Represents a design decision/pattern that multiple tournament implementations converged on. */
export interface ConvergentPattern {
  /** Human-readable description of the convergent design decision. AI-sourced — treat as untrusted input. */
  pattern: string;
  /** IDs of competitors that exhibited this pattern (corresponds to CompetitorResult.id). */
  competitors: number[];
  /** Confidence level 0-1 that this pattern is genuinely convergent. */
  confidence: number;
}

/** AI-driven semantic analysis of convergence across tournament implementations. */
export interface SemanticConvergenceAnalysis {
  /** Patterns that multiple implementations converged on. */
  convergent_patterns: ConvergentPattern[];
  /** Descriptions of fundamentally different approaches taken by competitors. AI-sourced — treat as untrusted input. */
  divergent_approaches: string[];
  /** AI assessment of whether synthesizing the best parts of multiple implementations is feasible. */
  synthesis_viable: boolean;
  /** AI explanation for the viability assessment. */
  rationale: string;
}

/** Result of attempting to synthesize the best parts of multiple tournament implementations. */
export interface SynthesisResult {
  /** Whether synthesis produced a valid, verified result. */
  success: boolean;
  /** The synthesized diff (may be empty on failure). */
  diff: string;
  /** Verification score 0-1 from scoreVerification. */
  verification_score: number;
  /** Explanation of what was synthesized or why synthesis failed. */
  rationale: string;
  /** Which convergent patterns were incorporated in the synthesis. */
  patterns_incorporated: string[];
  /** Path to synthesis worktree for caller cleanup. */
  worktreePath?: string;
  /** USD cost of the synthesis AI call(s). */
  cost: number;
}

/** Metadata capturing the full synthesis lifecycle within a tournament. */
export interface SynthesisMetadata {
  /** Whether synthesis was attempted (false if convergence below threshold). */
  attempted: boolean;
  /** Whether synthesis produced a verified result that was used. */
  succeeded: boolean;
  /** Whether synthesis was attempted but failed, falling back to single-winner selection. */
  fell_back_to_winner: boolean;
  /** Why synthesis was/wasn't attempted, or why it fell back. */
  rationale: string;
  /** The full semantic convergence analysis, if performed. */
  semantic_analysis?: SemanticConvergenceAnalysis;
  /** The full synthesis result, if synthesis was attempted. */
  synthesis_result?: SynthesisResult;
}

export interface TournamentResult {
  winnerId: number;
  winnerStrategy: string;
  competitors: CompetitorResult[];
  convergenceAnalysis?: ConvergenceAnalysis;
  judgeRationale?: string; // AI judge's explanation for the selection
  /** Synthesis metadata — present when convergence synthesis was evaluated. */
  synthesis?: SynthesisMetadata;
  totalCost: number;
}

// --- Claude CLI Response ---

export interface ClaudeResponse {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  total_cost_usd: number;
  structured_output?: unknown;
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
  cwd?: string;
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

import { describe, expect, test } from "bun:test";
import type {
  Config,
  ConvergentPattern,
  SemanticConvergenceAnalysis,
  SynthesisResult,
  SynthesisMetadata,
  TournamentResult,
  TournamentMetrics,
} from "../src/types";

function makeTestConfig(overrides?: Partial<Config>): Config {
  return {
    models: { planner: "opus", executor: "opus" },
    budget: {
      total_max_usd: 50.0,
      per_task_max_usd: 10.0,
      plan_max_usd: 2.0,
      execution_max_usd: 5.0,
      review_max_usd: 2.0,
      per_review_persona_max_usd: 0.80,
    },
    parallelism: { tournament_timeout_seconds: 600 },
    tournament: { competitors: 3, strategies: ["pragmatist", "thorough", "deconstructor"] },
    verification: { auto_detect: true, commands: [], max_retries: 2 },
    review: { enabled: true, max_retries: 2, personas: ["correctness", "security", "maintainability"] },
    git: { auto_commit: true, create_branch: true, create_pr: true },
    ...overrides,
  };
}

describe("Config type definition", () => {
  test("Verify Config type includes git.auto_commit as boolean", () => {
    const config = makeTestConfig();
    expect(typeof config.git.auto_commit).toBe("boolean");
    expect(config.git.auto_commit).toBe(true);
  });

  test("Verify Config type includes git.create_branch as boolean", () => {
    const config = makeTestConfig({ git: { auto_commit: true, create_branch: false, create_pr: true } });
    expect(typeof config.git.create_branch).toBe("boolean");
    expect(config.git.create_branch).toBe(false);
  });

  test("Verify Config type includes git.create_pr as boolean", () => {
    const config = makeTestConfig({ git: { auto_commit: true, create_branch: true, create_pr: false } });
    expect(typeof config.git.create_pr).toBe("boolean");
    expect(config.git.create_pr).toBe(false);
  });

  test("Test that a valid Config object with all git fields can be created", () => {
    const config = makeTestConfig();
    expect(config).toBeDefined();
    expect(config.git).toBeDefined();
    expect(config.git.auto_commit).toBeDefined();
    expect(config.git.create_branch).toBeDefined();
    expect(config.git.create_pr).toBeDefined();
  });

  test("Verify Config includes tournament section", () => {
    const config = makeTestConfig();
    expect(config.tournament).toBeDefined();
    expect(config.tournament.competitors).toBe(3);
    expect(config.tournament.strategies).toEqual(["pragmatist", "thorough", "deconstructor"]);
  });

  test("Test that TypeScript compilation succeeds with the updated type definition", () => {
    const config = makeTestConfig();

    const autoCommit: boolean = config.git.auto_commit;
    const createBranch: boolean = config.git.create_branch;
    const createPr: boolean = config.git.create_pr;

    expect(autoCommit).toBeDefined();
    expect(createBranch).toBeDefined();
    expect(createPr).toBeDefined();
  });
});

describe("ConvergentPattern type", () => {
  test("can be created with required fields", () => {
    const pattern: ConvergentPattern = {
      pattern: "Both implementations used middleware pattern for CSRF protection",
      competitors: [0, 2],
      confidence: 0.85,
    };
    expect(typeof pattern.pattern).toBe("string");
    expect(Array.isArray(pattern.competitors)).toBe(true);
    expect(typeof pattern.confidence).toBe("number");
  });

  test("accepts boundary confidence values 0.0 and 1.0", () => {
    const low: ConvergentPattern = { pattern: "weak pattern", competitors: [1], confidence: 0.0 };
    const high: ConvergentPattern = { pattern: "strong pattern", competitors: [0, 1, 2], confidence: 1.0 };
    expect(low.confidence).toBe(0.0);
    expect(high.confidence).toBe(1.0);
  });

  test("accepts empty competitors array", () => {
    const pattern: ConvergentPattern = { pattern: "unattributed pattern", competitors: [], confidence: 0.5 };
    expect(pattern.competitors).toHaveLength(0);
  });
});

describe("SemanticConvergenceAnalysis type", () => {
  test("can be created with required fields", () => {
    const analysis: SemanticConvergenceAnalysis = {
      convergent_patterns: [
        { pattern: "error handling pattern", competitors: [0, 1], confidence: 0.9 },
      ],
      divergent_approaches: ["Competitor 0 used classes, Competitor 1 used functions"],
      synthesis_viable: true,
      rationale: "High convergence on core logic, divergence only in style",
    };
    expect(analysis.convergent_patterns).toHaveLength(1);
    expect(analysis.divergent_approaches).toHaveLength(1);
    expect(analysis.synthesis_viable).toBe(true);
    expect(typeof analysis.rationale).toBe("string");
  });

  test("handles no convergence found (synthesis_viable=false, empty patterns)", () => {
    const analysis: SemanticConvergenceAnalysis = {
      convergent_patterns: [],
      divergent_approaches: ["Completely different approaches"],
      synthesis_viable: false,
      rationale: "No meaningful convergence detected",
    };
    expect(analysis.synthesis_viable).toBe(false);
    expect(analysis.convergent_patterns).toHaveLength(0);
  });
});

describe("SynthesisResult type", () => {
  test("can represent a successful synthesis", () => {
    const result: SynthesisResult = {
      success: true,
      diff: "diff --git a/src/middleware.ts b/src/middleware.ts\n+export function csrfMiddleware()...",
      verification_score: 0.95,
      rationale: "Combined error handling from C0 with middleware pattern from C2",
      patterns_incorporated: ["error handling", "middleware pattern"],
      cost: 0.12,
    };
    expect(result.success).toBe(true);
    expect(typeof result.diff).toBe("string");
    expect(typeof result.verification_score).toBe("number");
    expect(result.patterns_incorporated).toHaveLength(2);
    expect(typeof result.cost).toBe("number");
  });

  test("can represent a failed synthesis", () => {
    const result: SynthesisResult = {
      success: false,
      diff: "",
      verification_score: 0,
      rationale: "Synthesized code failed verification",
      patterns_incorporated: [],
      cost: 0.08,
    };
    expect(result.success).toBe(false);
    expect(result.diff).toBe("");
    expect(result.verification_score).toBe(0);
    expect(result.patterns_incorporated).toHaveLength(0);
  });

  test("accepts optional worktreePath", () => {
    const result: SynthesisResult = {
      success: true,
      diff: "some diff",
      verification_score: 0.9,
      rationale: "good",
      patterns_incorporated: ["p1"],
      worktreePath: "/tmp/convergent-synthesis-abc/s-0",
      cost: 0.15,
    };
    expect(typeof result.worktreePath).toBe("string");
  });
});

describe("SynthesisMetadata type", () => {
  test("synthesis attempted and succeeded", () => {
    const meta: SynthesisMetadata = {
      attempted: true,
      succeeded: true,
      fell_back_to_winner: false,
      rationale: "Convergence score 0.8 exceeded threshold 0.5",
    };
    expect(meta.attempted).toBe(true);
    expect(meta.succeeded).toBe(true);
    expect(meta.fell_back_to_winner).toBe(false);
  });

  test("synthesis attempted but fell back to winner", () => {
    const meta: SynthesisMetadata = {
      attempted: true,
      succeeded: false,
      fell_back_to_winner: true,
      rationale: "Synthesis failed verification, fell back to winner C-0",
    };
    expect(meta.fell_back_to_winner).toBe(true);
  });

  test("synthesis not attempted (below threshold)", () => {
    const meta: SynthesisMetadata = {
      attempted: false,
      succeeded: false,
      fell_back_to_winner: false,
      rationale: "Convergence score 0.3 below threshold 0.5",
    };
    expect(meta.attempted).toBe(false);
  });

  test("includes optional semantic_analysis and synthesis_result", () => {
    const meta: SynthesisMetadata = {
      attempted: true,
      succeeded: true,
      fell_back_to_winner: false,
      rationale: "Synthesis succeeded",
      semantic_analysis: {
        convergent_patterns: [{ pattern: "p1", competitors: [0, 1], confidence: 0.9 }],
        divergent_approaches: [],
        synthesis_viable: true,
        rationale: "High convergence",
      },
      synthesis_result: {
        success: true,
        diff: "some diff",
        verification_score: 0.95,
        rationale: "Combined best parts",
        patterns_incorporated: ["p1"],
        cost: 0.1,
      },
    };
    expect(meta.semantic_analysis).toBeDefined();
    expect(meta.synthesis_result).toBeDefined();
  });
});

describe("TournamentResult backward compatibility", () => {
  test("TournamentResult without synthesis field is valid", () => {
    const result: TournamentResult = {
      winnerId: 0,
      winnerStrategy: "thorough",
      competitors: [],
      totalCost: 1.5,
    };
    expect(result.winnerId).toBe(0);
    expect(result.synthesis).toBeUndefined();
  });

  test("TournamentResult with synthesis field is valid", () => {
    const result: TournamentResult = {
      winnerId: 0,
      winnerStrategy: "thorough",
      competitors: [],
      totalCost: 1.5,
      synthesis: {
        attempted: true,
        succeeded: true,
        fell_back_to_winner: false,
        rationale: "Synthesis succeeded",
      },
    };
    expect(result.synthesis).toBeDefined();
    expect(result.synthesis!.attempted).toBe(true);
  });
});

describe("Config tournament convergence_threshold", () => {
  test("makeTestConfig works without convergence_threshold (backward compat)", () => {
    const config = makeTestConfig();
    expect(config.tournament.convergence_threshold).toBeUndefined();
  });

  test("Config accepts convergence_threshold", () => {
    const config = makeTestConfig();
    config.tournament.convergence_threshold = 0.5;
    expect(config.tournament.convergence_threshold).toBe(0.5);
  });

  test("convergence_threshold boundary values 0.0 and 1.0", () => {
    const config = makeTestConfig();
    config.tournament.convergence_threshold = 0.0;
    expect(config.tournament.convergence_threshold).toBe(0.0);
    config.tournament.convergence_threshold = 1.0;
    expect(config.tournament.convergence_threshold).toBe(1.0);
  });
});

describe("TournamentMetrics synthesis fields", () => {
  test("TournamentMetrics without synthesis fields is valid", () => {
    const metrics = {} as TournamentMetrics;
    expect(metrics.synthesis_attempted).toBeUndefined();
  });

  test("TournamentMetrics with synthesis fields is valid", () => {
    const metrics: Partial<TournamentMetrics> = {
      synthesis_attempted: true,
      synthesis_succeeded: false,
    };
    expect(metrics.synthesis_attempted).toBe(true);
    expect(metrics.synthesis_succeeded).toBe(false);
  });
});

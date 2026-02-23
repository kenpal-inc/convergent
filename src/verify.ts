import { mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { log } from "./logger";
import type { Config } from "./types";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface CommandResult {
  cmd: string;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

async function runCommand(
  cmd: string,
  projectRoot: string,
  timeoutMs: number,
): Promise<CommandResult> {
  try {
    const proc = Bun.spawn(["sh", "-c", cmd], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    return {
      cmd,
      passed: !timedOut && exitCode === 0,
      stdout,
      stderr,
      exitCode: timedOut ? null : exitCode,
      timedOut,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      cmd,
      passed: false,
      stdout: "",
      stderr: msg,
      exitCode: null,
      timedOut: false,
    };
  }
}

/**
 * Auto-detect verification commands from project structure.
 * Checks for tsconfig.json, package.json scripts, prettier config.
 */
export function autoDetectVerification(projectRoot: string): string[] {
  const commands: string[] = [];

  if (existsSync(join(projectRoot, "tsconfig.json"))) {
    commands.push("bunx tsc --noEmit");
  }

  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.lint) commands.push("bun run lint");
      if (pkg.scripts?.test) commands.push("bun test");
      if (pkg.devDependencies?.prettier || pkg.dependencies?.prettier) {
        commands.push("bunx prettier --check .");
      }
    } catch { /* ignore parse errors */ }
  }

  return commands;
}

/**
 * Resolve which verification commands to use:
 * 1. If config.verification.commands is non-empty, use those
 * 2. If auto_detect is true (default), auto-detect from project
 * 3. Otherwise, empty (no verification)
 */
export function resolveVerificationCommands(config: Config, projectRoot: string): string[] {
  if (config.verification.commands && config.verification.commands.length > 0) {
    return config.verification.commands;
  }
  if (config.verification.auto_detect !== false) {
    return autoDetectVerification(projectRoot);
  }
  return [];
}

export async function runVerification(
  taskId: string,
  config: Config,
  projectRoot: string,
  outputDir: string,
): Promise<boolean> {
  const commands = resolveVerificationCommands(config, projectRoot);

  if (!commands || commands.length === 0) {
    log.info("No verification commands configured or detected, skipping verification");
    return true;
  }

  const taskDir = `${outputDir}/logs/task-${taskId}`;
  mkdirSync(taskDir, { recursive: true });
  const verifyLogPath = `${taskDir}/verify.log`;

  log.info("Running verification...");

  const timeoutMs = (config.verification.timeout_seconds ?? 300) * 1000 || DEFAULT_TIMEOUT_MS;
  const parallel = config.verification.parallel !== false; // default true

  const now = new Date().toISOString();
  let logContent = `=== Verification Run ${now} ===\nTask: ${taskId}\nMode: ${parallel ? "parallel" : "sequential"}\nTimeout: ${timeoutMs / 1000}s per command\n\n`;

  let results: CommandResult[];

  if (parallel && commands.length > 1) {
    log.info(`  Running ${commands.length} commands in parallel...`);
    results = await Promise.all(
      commands.map(cmd => runCommand(cmd, projectRoot, timeoutMs)),
    );
  } else {
    results = [];
    for (const cmd of commands) {
      log.info(`  Running: ${cmd}`);
      const result = await runCommand(cmd, projectRoot, timeoutMs);
      results.push(result);
    }
  }

  let allPassed = true;
  for (const r of results) {
    logContent += `--- Running: ${r.cmd} ---\n`;
    logContent += r.stdout;
    if (r.stderr) logContent += r.stderr;

    if (r.timedOut) {
      logContent += `--- TIMEOUT (killed after ${timeoutMs / 1000}s) ---\n\n`;
      log.warn(`  TIMEOUT: ${r.cmd} (killed after ${timeoutMs / 1000}s)`);
      allPassed = false;
    } else if (r.passed) {
      logContent += `--- PASSED ---\n\n`;
      log.ok(`  PASS: ${r.cmd}`);
    } else {
      logContent += `--- FAILED (exit code: ${r.exitCode}) ---\n\n`;
      log.warn(`  FAIL: ${r.cmd}`);
      allPassed = false;
    }
  }

  await Bun.write(verifyLogPath, logContent);

  if (allPassed) {
    log.ok("All verification checks passed");
  } else {
    log.warn(`Verification failed - see ${verifyLogPath}`);
  }

  return allPassed;
}

// --- Tournament scoring ---

interface VerificationScoreDetail {
  name: string;
  passed: boolean;
  weight: number;
}

interface VerificationScore {
  totalScore: number;
  maxScore: number;
  allPassed: boolean;
  details: VerificationScoreDetail[];
}

const VERIFICATION_WEIGHTS: Record<string, number> = {
  test: 40,
  typecheck: 30,
  lint: 15,
  format: 15,
};

function classifyCommand(cmd: string): string {
  const lower = cmd.toLowerCase();
  if (lower.includes("tsc") || lower.includes("typecheck")) return "typecheck";
  if (lower.includes("test")) return "test";
  if (lower.includes("prettier") || lower.includes("format")) return "format";
  if (lower.includes("lint") || lower.includes("eslint") || lower.includes("biome")) return "lint";
  return "other";
}

/**
 * Run verification commands and return a score (for tournament ranking).
 * Unlike runVerification, this does NOT write to task-specific dirs.
 */
export async function scoreVerification(
  commands: string[],
  projectRoot: string,
  timeoutMs: number = 300_000,
): Promise<VerificationScore> {
  if (commands.length === 0) {
    return { totalScore: 100, maxScore: 100, allPassed: true, details: [] };
  }

  const results = await Promise.all(
    commands.map(cmd => runCommand(cmd, projectRoot, timeoutMs)),
  );

  const details: VerificationScoreDetail[] = results.map(r => {
    const category = classifyCommand(r.cmd);
    const weight = VERIFICATION_WEIGHTS[category] ?? 10;
    return { name: category, passed: r.passed, weight };
  });

  const maxScore = details.reduce((s, d) => s + d.weight, 0);
  const totalScore = details.reduce((s, d) => s + (d.passed ? d.weight : 0), 0);
  const allPassed = details.every(d => d.passed);

  return { totalScore, maxScore, allPassed, details };
}

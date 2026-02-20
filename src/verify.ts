import { mkdirSync } from "fs";
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

export async function runVerification(
  taskId: string,
  config: Config,
  projectRoot: string,
  outputDir: string,
): Promise<boolean> {
  const commands = config.verification.commands;

  if (!commands || commands.length === 0) {
    log.info("No verification commands configured, skipping verification");
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

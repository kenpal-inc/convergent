import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[0;33m";
const BLUE = "\x1b[0;34m";
const CYAN = "\x1b[0;36m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

let logFilePath: string | null = null;
let verboseEnabled = false;

function timestamp(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function write(level: string, color: string, ...args: unknown[]): void {
  const msg = args.map(String).join(" ");
  const formatted = `${color}[${level.padEnd(5)}]${NC} ${timestamp()} ${msg}`;
  console.log(formatted);
  if (logFilePath) {
    appendFileSync(logFilePath, stripAnsi(formatted) + "\n");
  }
}

export const log = {
  info: (...args: unknown[]) => write("INFO", BLUE, ...args),
  ok: (...args: unknown[]) => write("OK", GREEN, ...args),
  warn: (...args: unknown[]) => write("WARN", YELLOW, ...args),
  error: (...args: unknown[]) => write("ERROR", RED, ...args),
  phase: (...args: unknown[]) => write("PHASE", CYAN, ...args),
  debug: (...args: unknown[]) => {
    if (verboseEnabled) write("DEBUG", NC, ...args);
  },
  bold: (msg: string) => `${BOLD}${msg}${NC}`,
  green: (msg: string) => `${GREEN}${msg}${NC}`,
  red: (msg: string) => `${RED}${msg}${NC}`,
  yellow: (msg: string) => `${YELLOW}${msg}${NC}`,
  blue: (msg: string) => `${BLUE}${msg}${NC}`,
  cyan: (msg: string) => `${CYAN}${msg}${NC}`,
};

export function initLogging(outputDir: string): void {
  const logsDir = `${outputDir}/logs`;
  mkdirSync(logsDir, { recursive: true });
  logFilePath = `${logsDir}/orchestrator.log`;
}

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

export function die(...args: unknown[]): never {
  log.error(...args);
  process.exit(1);
}

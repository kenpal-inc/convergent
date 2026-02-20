/**
 * Project structure summarizer — generates a compact file tree with first-line
 * descriptions for each source file. This gives Phase A personas a bird's-eye
 * view of the codebase without reading every file in full.
 */

import { Glob } from "bun";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve, relative } from "path";
import { log } from "./logger";

const EXCLUDE_DIRS = ["node_modules", ".next", "dist", ".convergent", ".git", "coverage", "__pycache__"];
const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,py,go,rs,java,rb,php,c,cpp,h,hpp,cs}";
const MAX_FILES_FOR_SUMMARY = 200;

function shouldExclude(filePath: string): boolean {
  return EXCLUDE_DIRS.some(
    (dir) => filePath.includes(`/${dir}/`) || filePath.includes(`\\${dir}\\`),
  );
}

/**
 * Extract a one-line description from a source file.
 * Strategy: first JSDoc/docstring, first comment, or first meaningful line.
 */
function extractOneLiner(filePath: string): string {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }

  const lines = content.split("\n").slice(0, 20); // only check first 20 lines

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and shebang
    if (!trimmed || trimmed.startsWith("#!")) continue;

    // JSDoc/TSDoc: /** ... */
    const jsdocMatch = trimmed.match(/^\/\*\*\s*(.+?)(?:\s*\*\/)?$/);
    if (jsdocMatch) return jsdocMatch[1].replace(/\*\/$/, "").trim();

    // Multi-line doc start: /** or """
    if (trimmed === "/**" || trimmed === '"""' || trimmed === "'''") {
      // Look for the next meaningful line
      const idx = lines.indexOf(line);
      for (let i = idx + 1; i < lines.length; i++) {
        const nextTrimmed = lines[i].trim().replace(/^\*\s*/, "").replace(/\*\/$/, "").trim();
        if (nextTrimmed && nextTrimmed !== "*" && nextTrimmed !== '"""' && nextTrimmed !== "'''") {
          return nextTrimmed;
        }
      }
      continue;
    }

    // Single-line comment: // or #
    const commentMatch = trimmed.match(/^(?:\/\/|#)\s*(.+)/);
    if (commentMatch) return commentMatch[1];

    // If it's an import/require, skip
    if (trimmed.startsWith("import ") || trimmed.startsWith("from ") || trimmed.startsWith("require(")) continue;
    if (trimmed.startsWith("use ") || trimmed.startsWith("package ")) continue;

    // First meaningful code line (export, function, class, etc.)
    if (trimmed.startsWith("export ") || trimmed.startsWith("function ") ||
        trimmed.startsWith("class ") || trimmed.startsWith("interface ") ||
        trimmed.startsWith("type ") || trimmed.startsWith("const ") ||
        trimmed.startsWith("def ") || trimmed.startsWith("fn ") ||
        trimmed.startsWith("pub ") || trimmed.startsWith("struct ")) {
      return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
    }
  }

  return "";
}

/**
 * Generate a project structure summary: file tree with one-line descriptions.
 * Returns a markdown-formatted string suitable for prepending to prompts.
 */
export async function generateProjectSummary(
  projectRoot: string,
): Promise<string> {
  const glob = new Glob(SOURCE_GLOB);
  const files: string[] = [];

  for await (const file of glob.scan({ cwd: projectRoot, absolute: true })) {
    if (!shouldExclude(file)) {
      files.push(file);
    }
  }

  files.sort();
  const summaryFiles = files.slice(0, MAX_FILES_FOR_SUMMARY);

  if (summaryFiles.length === 0) {
    return "(no source files found)";
  }

  const lines: string[] = ["## Project Structure Summary", ""];

  for (const absPath of summaryFiles) {
    const relPath = relative(projectRoot, absPath);
    const oneLiner = extractOneLiner(absPath);
    if (oneLiner) {
      lines.push(`- \`${relPath}\` — ${oneLiner}`);
    } else {
      lines.push(`- \`${relPath}\``);
    }
  }

  if (files.length > MAX_FILES_FOR_SUMMARY) {
    lines.push(`\n... and ${files.length - MAX_FILES_FOR_SUMMARY} more files`);
  }

  log.debug(`Generated project summary: ${summaryFiles.length} files`);
  return lines.join("\n");
}

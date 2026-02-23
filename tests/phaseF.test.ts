import { describe, test, expect } from "bun:test";
import { extractJSON } from "../src/phaseF";

describe("extractJSON", () => {
  test("parses clean JSON", () => {
    const result = extractJSON<{ coherent: boolean }>(
      '{"issues": [], "coherent": true}',
    );
    expect(result.coherent).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("extracts JSON from ```json fenced block", () => {
    const text = `Based on my analysis:\n\n\`\`\`json\n{"issues": [{"severity": "critical", "description": "missing route", "fix_hint": "create it"}], "coherent": false}\n\`\`\``;
    const result = extractJSON<{ coherent: boolean; issues: unknown[] }>(text);
    expect(result.coherent).toBe(false);
    expect(result.issues).toHaveLength(1);
  });

  test("extracts JSON from ``` fenced block without json tag", () => {
    const text = `Here are the results:\n\n\`\`\`\n{"issues": [], "coherent": true}\n\`\`\`\n\nLooks good!`;
    const result = extractJSON<{ coherent: boolean }>(text);
    expect(result.coherent).toBe(true);
  });

  test("extracts JSON from surrounding prose text", () => {
    const text = `After analysis, here is the result: {"issues": [], "coherent": true} — that's all.`;
    const result = extractJSON<{ coherent: boolean }>(text);
    expect(result.coherent).toBe(true);
  });

  test("handles multiline JSON in fenced block", () => {
    const text = `Summary:\n\n\`\`\`json\n{\n  "issues": [\n    {\n      "severity": "critical",\n      "description": "test",\n      "fix_hint": "fix"\n    }\n  ],\n  "coherent": false\n}\n\`\`\``;
    const result = extractJSON<{ issues: unknown[] }>(text);
    expect(result.issues).toHaveLength(1);
  });

  test("throws on text with no JSON", () => {
    expect(() => extractJSON("No JSON here at all")).toThrow("No JSON object found");
  });

  test("throws on empty string", () => {
    expect(() => extractJSON("")).toThrow();
  });
});

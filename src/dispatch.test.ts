import { describe, expect, test, beforeEach } from "bun:test";
import { classifyMessage, TaskType } from "./dispatch";
import { __resetDedupForTests, isDuplicate, markProcessed } from "./dispatch-dedup";

describe("classifyMessage", () => {
  const cases: Array<{ message: string; expected: TaskType }> = [
    { message: "scrie cod pentru parserul de comenzi", expected: TaskType.CODE },
    { message: "please refactor this function and fix bug", expected: TaskType.CODE },
    { message: "cercetează trendurile AI pentru 2026", expected: TaskType.RESEARCH },
    { message: "find out latest benchmarks for Bun runtime", expected: TaskType.RESEARCH },
    { message: "analizează competitor și revenue pentru acest market", expected: TaskType.BUSINESS },
    { message: "care e prețul corect pentru client enterprise?", expected: TaskType.BUSINESS },
    { message: "restart service și verifică status + health check", expected: TaskType.SYSTEM },
    { message: "run deploy and then git push", expected: TaskType.SYSTEM },
    { message: "programează o întâlnire mâine în calendar", expected: TaskType.CALENDAR },
    { message: "schedule meeting and set a reminder", expected: TaskType.CALENDAR },
    { message: "trimite mail către client și verifică inbox", expected: TaskType.EMAIL },
    { message: "please draft an email follow-up", expected: TaskType.EMAIL },
    { message: "fă audit și verifică codul înainte de release", expected: TaskType.AUDIT },
    { message: "run forge review on this module", expected: TaskType.AUDIT },
  ];

  test("classifies EN/RO examples across all task types", () => {
    for (const item of cases) {
      const result = classifyMessage(item.message);
      expect(result.type).toBe(item.expected);
      expect(result.confidence).toBeGreaterThan(0.6);
      expect(result.patterns.length).toBeGreaterThan(0);
    }
  });

  test("returns general for non-task text", () => {
    const result = classifyMessage("ce mai faci azi?");
    expect(result.type).toBe(TaskType.GENERAL);
    expect(result.confidence).toBeLessThan(0.6);
  });

  test("keeps ambiguous mixed-intent messages below dispatch threshold", () => {
    const result = classifyMessage("research market and write code");
    expect(result.confidence).toBeLessThan(0.6);
  });
});

describe("dispatch dedup", () => {
  beforeEach(() => {
    __resetDedupForTests();
  });

  test("same message is duplicate after markProcessed", () => {
    const message = "scrie cod pentru handler";
    expect(isDuplicate(message)).toBe(false);
    markProcessed(message);
    expect(isDuplicate(message)).toBe(true);
  });

  test("exact-match only: variant text is not duplicate", () => {
    const first = "trimite mail client";
    const second = "trimite mail client.";
    markProcessed(first);
    expect(isDuplicate(first)).toBe(true);
    expect(isDuplicate(second)).toBe(false);
  });
});

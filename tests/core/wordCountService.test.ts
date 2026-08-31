import { describe, expect, it } from "vitest";
import {
  countShenlunCharacters,
  formatShenlunCharacterCount,
} from "../../src/services/wordCountService";

describe("countShenlunCharacters", () => {
  it("counts visible Unicode code points and ignores whitespace", () => {
    expect(countShenlunCharacters("申 论\tA1，!\n𠀀😀\u3000")).toBe(8);
  });

  it("does not split surrogate pairs", () => {
    expect(countShenlunCharacters("😀𠀀")).toBe(2);
  });

  it("formats counts with and without a limit", () => {
    expect(formatShenlunCharacterCount("申 论", 300)).toBe("2 / 300 字");
    expect(formatShenlunCharacterCount("申 论", null)).toBe("2 字");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { extractFromActiveTab } from "../../src/background/exam-bridge";

afterEach(() => vi.unstubAllGlobals());

describe("exam extraction window routing", () => {
  it("targets the source browser window when invoked from a floating extension window", async () => {
    const query = vi.fn(async () => []);
    vi.stubGlobal("chrome", { tabs: { query } });

    await expect(extractFromActiveTab(42)).resolves.toMatchObject({ ok: false });
    expect(query).toHaveBeenCalledWith({ active: true, windowId: 42 });
  });

  it("keeps current-window routing for the pinned side panel", async () => {
    const query = vi.fn(async () => []);
    vi.stubGlobal("chrome", { tabs: { query } });

    await expect(extractFromActiveTab()).resolves.toMatchObject({ ok: false });
    expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });
});

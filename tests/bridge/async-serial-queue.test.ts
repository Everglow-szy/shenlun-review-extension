import { describe, expect, it } from "vitest";
import { AsyncSerialQueue } from "../../src/background/async-serial-queue";

describe("AsyncSerialQueue", () => {
  it("does not allow two tab reservations to overlap", async () => {
    const queue = new AsyncSerialQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = queue.run(async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});

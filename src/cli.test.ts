import { describe, expect, it, vi } from "vitest";
import { run } from "./cli.js";

describe("CLI", () => {
  it("prints the version", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(run(["--version"])).toBe(0);
    expect(log).toHaveBeenCalledWith("0.0.0");
    log.mockRestore();
  });

  it("rejects unknown commands", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(run(["wat"])).toBe(1);
    error.mockRestore();
  });
});

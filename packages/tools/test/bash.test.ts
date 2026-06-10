import { describe, expect, it } from "vitest";
import { bashTool, BASH_OUTPUT_CAP } from "../src/index.js";
import { makeCtx } from "./helpers.js";

describe("Bash", () => {
  it("runs a pipeline and returns stdout + exit 0", async () => {
    const { ctx } = makeCtx({ "/data.txt": "b\na\nc\n" });
    const res = await bashTool({ command: "cat /data.txt | sort" }, ctx);
    expect(res.stdout).toBe("a\nb\nc\n");
    expect(res.exitCode).toBe(0);
    expect(res.output).toBe("a\nb\nc\n");
  });

  it("captures stderr and a non-zero exit for command-not-found", async () => {
    const { ctx } = makeCtx();
    const res = await bashTool({ command: "doesnotexist" }, ctx);
    expect(res.exitCode).toBe(127);
    expect(res.stderr).toContain("command not found");
    expect(res.output).toContain("[stderr]");
  });

  it("includes an [stderr] section in combined output when stderr present", async () => {
    const { ctx } = makeCtx();
    const res = await bashTool({ command: "echo out; doesnotexist" }, ctx);
    expect(res.stdout).toContain("out");
    expect(res.output).toContain("out");
    expect(res.output).toContain("[stderr]");
  });

  it("echoes to stdout", async () => {
    const { ctx } = makeCtx();
    const res = await bashTool({ command: "echo hello" }, ctx);
    expect(res.stdout).toBe("hello\n");
  });

  it("truncates very large output", async () => {
    const { ctx } = makeCtx();
    // Produce a long line via printf of a big string.
    const big = "x".repeat(BASH_OUTPUT_CAP + 100);
    const res = await bashTool({ command: `echo ${big}` }, ctx);
    expect(res.output.length).toBeLessThan(BASH_OUTPUT_CAP + 200);
    expect(res.output).toContain("truncated");
  });
});

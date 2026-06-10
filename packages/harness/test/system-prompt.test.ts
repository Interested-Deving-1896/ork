import { describe, expect, it } from "vitest";
import { defaultSystemPrompt } from "../src/index.js";

describe("defaultSystemPrompt", () => {
  it("includes the working directory and the tool names", () => {
    const p = defaultSystemPrompt({ cwd: "/workspace" });
    expect(p).toContain("/workspace");
    for (const tool of ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]) {
      expect(p).toContain(tool);
    }
  });

  it("states the network is OFF by default", () => {
    const p = defaultSystemPrompt({ cwd: "/" });
    expect(p).toContain("Network: OFF");
  });

  it("describes an allow-list when network is configured", () => {
    const p = defaultSystemPrompt({
      cwd: "/",
      network: { allowedUrlPrefixes: ["https://api.example.com"] },
    });
    expect(p).toContain("allow-list");
  });

  it("lists mount points with their modes", () => {
    const p = defaultSystemPrompt({
      cwd: "/workspace",
      mounts: [
        { path: "/workspace", mode: "rw" },
        { path: "/knowledge", mode: "ro" },
      ],
    });
    expect(p).toContain("/knowledge");
    expect(p).toContain("read-only");
    expect(p).toContain("read-write");
  });

  it("mentions the virtual filesystem and durable persistence", () => {
    const p = defaultSystemPrompt({ cwd: "/" });
    expect(p.toLowerCase()).toContain("filesystem");
    expect(p.toLowerCase()).toContain("persist");
  });
});

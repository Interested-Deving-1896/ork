import { expect, test } from "vitest";
import { KERNEL_VERSION } from "../src/index.js";

test("package loads", () => {
  expect(KERNEL_VERSION).toBe("0.0.1");
});

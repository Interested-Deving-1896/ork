import { expect, test } from "vitest";
import { KernelError, isKernelError } from "../src/errors.js";

test("KernelError carries code and formatted message", () => {
  const err = new KernelError("ENOENT", "/missing.txt");
  expect(err.code).toBe("ENOENT");
  expect(err.message).toBe("ENOENT: /missing.txt");
  expect(err.name).toBe("KernelError");
  expect(err).toBeInstanceOf(Error);
});

test("isKernelError narrows correctly", () => {
  expect(isKernelError(new KernelError("EQUOTA", "x"))).toBe(true);
  expect(isKernelError(new Error("x"))).toBe(false);
  expect(isKernelError(null)).toBe(false);
});

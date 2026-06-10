export type ErrnoCode =
  | "ENOENT"
  | "EEXIST"
  | "EISDIR"
  | "ENOTDIR"
  | "ENOTEMPTY"
  | "EACCES"
  | "EINVAL"
  | "EQUOTA"
  | "ETIMEOUT"
  | "ENETBLOCKED";

export class KernelError extends Error {
  readonly code: ErrnoCode;

  constructor(code: ErrnoCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "KernelError";
    this.code = code;
  }
}

export function isKernelError(err: unknown): err is KernelError {
  return err instanceof KernelError;
}

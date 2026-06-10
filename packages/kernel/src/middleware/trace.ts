import { isKernelError } from "../errors.js";
import type { EventBus } from "../events.js";
import type { Middleware } from "../syscalls.js";

export function traceMiddleware(bus: EventBus): Middleware {
  return async (call, next) => {
    const path = call.path ?? call.url;
    try {
      const result = await next();
      bus.emit({ type: "syscall", name: call.name, path, ok: true });
      if (call.name === "writeFile" && call.path !== undefined && call.bytes !== undefined) {
        bus.emit({ type: "fs.write", path: call.path, bytes: call.bytes });
      }
      return result;
    } catch (err) {
      bus.emit({
        type: "syscall",
        name: call.name,
        path,
        ok: false,
        code: isKernelError(err) ? err.code : "UNKNOWN",
      });
      throw err;
    }
  };
}

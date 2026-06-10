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
      if (call.name === "fetch" && call.url !== undefined) {
        bus.emit({ type: "net.fetch", url: call.url, method: call.method ?? "GET", status: (result as Response).status });
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

import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import type { ScanOptions } from "../core/types.js";

/** A small store facade: all writes are checked before invoking the backing store.
 * Pass namespace/key/value as the store expects. Batch/delete APIs are deliberately not exposed.
 */
export function guardStore<P extends unknown[], G extends unknown[], R>(
  store: { put: (...args: P) => unknown | Promise<unknown>; get: (...args: G) => R | Promise<R> },
  options: ScanOptions & { sdkClient?: Client } = {},
) {
  const { sdkClient = getClient(), ...metadata } = options;
  return {
    async put(...args: P) {
      await sdkClient.scanMemoryWrite(args, { framework: "memory", ...metadata, operation: "put", enforce: true });
      return store.put(...args);
    },
    async get(...args: G): Promise<R> {
      const result = await store.get(...args);
      await sdkClient.scanToolResult("memory.get", typeof result === "string" ? result : JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value) ?? "", {
        framework: "memory", ...metadata, enforce: true, before_delivery: true,
      });
      return result;
    },
  };
}

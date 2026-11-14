import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import type { ScanOptions } from "../core/types.js";

const writes = ["add", "upsert", "update", "addDocuments", "addTexts", "addVectors"] as const;
type Write = typeof writes[number];
type Guarded<T> = { [K in Extract<Write, keyof T>]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };

/** Explicit facade for native vector-store writes. contentOf must return the complete plaintext
 * and metadata for the whole batch; embeddings alone cannot be scanned for instructions.
 * Does not forward other methods. All exposed methods are async and retain the provider's `this`.
 */
export function guardVectorStore<T extends object>(store: T, options: ScanOptions & {
  sdkClient?: Client;
  store?: string;
  contentOf: (operation: Write, args: unknown[]) => unknown;
}): Guarded<T> {
  const { sdkClient = getClient(), contentOf, store: name = "vector", ...metadata } = options;
  const guarded: Record<string, unknown> = {};
  for (const operation of writes) {
    const method = (store as Record<string, unknown>)[operation];
    if (typeof method !== "function") continue;
    guarded[operation] = async (...args: unknown[]) => {
      const content = contentOf(operation, args);
      await sdkClient.scanMemoryWrite(content, { framework: "memory", ...metadata, store: name, operation, enforce: true });
      return method.apply(store, args);
    };
  }
  return guarded as Guarded<T>;
}

import { Client } from "../core/client.js";
import { getClient } from "../index.js";
import { wrapRunMethods } from "./common.js";

export function instrumentAutoGen<T extends object>(
  target: T,
  options: { framework?: string; sdkClient?: Client } = {},
): T {
  return wrapRunMethods(target, ["run", "runStream", "run_stream", "initiateChat"], options.sdkClient ?? getClient(), options.framework ?? "autogen");
}

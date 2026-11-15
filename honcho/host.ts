import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./lib/host-contract.js";
import { harnessHostHandlers } from "./lib/harness/host-ops.js";
import { createRecallHostHandlers } from "./lib/recall/host-handlers.js";

/** The plugin's single host entry: recall's cache writer and harness's file ops. */
const recall = createRecallHostHandlers();

export { hostContract };

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { ...recall.handlers, ...harnessHostHandlers() },
  dispose: () => { recall.dispose(); },
});

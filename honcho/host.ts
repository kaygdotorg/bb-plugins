import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { recallHostContract } from "./lib/recall/host-contract.js";
import { createRecallHostHandlers } from "./lib/recall/host-handlers.js";

/** The plugin's single host entry. Other slices merge their contracts and
 * handlers here the same way the recall slice does. */
const recall = createRecallHostHandlers();

export const hostContract = { ...recallHostContract };

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { ...recall.handlers },
  dispose: () => { recall.dispose(); },
});

// The plugin's one host contract: every slice's host ops, merged. host.ts
// implements it, and server.ts builds the plugin's one host client from it.
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { harnessHostContract } from "./harness/host-ops.js";
import { recallHostContract } from "./recall/host-contract.js";

for (const name of Object.keys(harnessHostContract)) {
  if (name in recallHostContract) throw new Error(`host op ${name} is defined twice`);
}

export const hostContract = { ...recallHostContract, ...harnessHostContract };
export type HostContract = typeof hostContract;
export type HostClient = ExperimentalHostClient<HostContract>;

export function createHostClient(bb: Pick<BbPluginApi, "hosts">): HostClient {
  return bb.hosts.experimental_client({ contract: hostContract });
}

export { createHarnessService, harnessHostCaller, type HarnessCaller, type HarnessDeps, type HarnessServiceWithSteps } from "./service.js";
export { registerProviderEnv, DEFAULT_HOOK_BUDGET_MS, type ProviderEnvDeps } from "./env.js";
export { registerHarnessHostOps, harnessHostContract, harnessHostHandlers, type HarnessHostOptions, type HarnessOp } from "./host-ops.js";
export type { UndoStep, EnvPaths, HostHarnessState } from "./ops.js";

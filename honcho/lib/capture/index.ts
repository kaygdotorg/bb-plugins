export { createCaptureService, gateAlwaysOpen, sanitizeSessionName, SWITCHOVER_ENV, NOT_SWITCHED_OVER, type CaptureHandle } from "./service.js";
export { createScopeResolver, threadFacts, type ThreadRef } from "./scope.js";
export { filesGitInfo, systemClock, type CaptureBb, type CaptureDeps, type Clock, type GitInfoReader } from "./ports.js";
export { denyReason, globMatcher } from "./deny.js";

// Export the main agent class and utilities for library usage
export {
  ClaudeAcpAgent,
  isLocalCommandMetadata,
  stripLocalCommandMetadata,
  runAcp,
  toAcpNotifications,
  streamEventToAcpNotifications,
  type ToolUpdateMeta,
  type NewSessionMeta,
  type SDKMessageFilter,
} from "./acp-agent.js";
export { nodeToWebReadable, nodeToWebWritable, Pushable, unreachable } from "./utils.js";
export {
  toolInfoFromToolUse,
  toDisplayPath,
  planEntries,
  toolUpdateFromToolResult,
} from "./tools.js";
export { SettingsManager, type SettingsManagerOptions } from "./settings.js";
// The `authStatus` extension's wire surface: the notification's method name and
// the payload types needed to read the traffic. The mappers stay internal.
export {
  AUTH_STATUS_UPDATE_METHOD,
  type AuthStatus,
  type AuthStatusAccount,
  type AuthStatusKind,
  type AuthStatusUpdateNotification,
} from "./auth-status.js";

// Export types
export type { ClaudePlanEntry } from "./tools.js";

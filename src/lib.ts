// The package's public API: serve ACP (v1 and v2) on stdio, and the wire
// names of the `authStatus` extension that a client needs to read its traffic.
export { serveAcp, type AcpProtocols } from "./serve.js";
export type { Logger } from "./logger.js";
export {
  AUTH_STATUS_UPDATE_METHOD,
  type AuthStatus,
  type AuthStatusAccount,
  type AuthStatusKind,
  type AuthStatusUpdateNotification,
} from "./auth-status.js";

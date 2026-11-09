/**
 * Logger interface for customizing logging output
 */
export interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
  /** Optional: a caller that supplies no `warn` gets its warnings on `error`. */
  warn?: (...args: any[]) => void;
}

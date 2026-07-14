/**
 * Shared response "envelope" returned by every tool.
 *
 * Shape comes from course lesson S03E04: all tools share `next_action`, `recovery`
 * and `diagnostics` so the (future) agent always knows what it got back and what to do next.
 */
export interface ToolResponse<T> {
  /** Did the operation succeed? */
  success: boolean;
  /** The actual payload (present on success). */
  data?: T;
  /** Hint about the next useful step (e.g. "use gmail_read with this id"). */
  next_action?: string;
  /** What to do when something went wrong, was empty, or was partial. */
  recovery?: string;
  /** Behind-the-scenes info: the query that ran, counts, limits hit, etc. */
  diagnostics?: Record<string, unknown>;
}

/** Build a successful response, optionally attaching next_action/recovery/diagnostics. */
export function ok<T>(data: T, extra: Partial<ToolResponse<T>> = {}): ToolResponse<T> {
  return { success: true, data, ...extra };
}

/** Build a failed response with a recovery hint (and optional diagnostics). */
export function fail(recovery: string, diagnostics?: Record<string, unknown>): ToolResponse<never> {
  return diagnostics ? { success: false, recovery, diagnostics } : { success: false, recovery };
}

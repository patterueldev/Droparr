import type { User } from "./types.js";

/**
 * Whether a drop must wait for an admin before anything reaches the *arrs.
 * Admins auto-approve their own drops; submitters skip approval only when an
 * admin has marked them trusted.
 *
 * This is the decision the M3.3 pending queue evaluates when a submission is
 * created — the queue itself (state, approve/reject) is not part of this
 * helper.
 */
export function requiresApproval(
  user: Pick<User, "role" | "trusted">,
): boolean {
  return user.role !== "admin" && !user.trusted;
}

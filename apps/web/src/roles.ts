import type { UserRole } from "@droparr/shared";

export type Tab = "import" | "history" | "users" | "settings" | "account";

/**
 * Tabs each role can see. Admins get the full app; submitters only their
 * account (the drop flow and submission status arrive in M3).
 */
export function tabsForRole(role: UserRole): { id: Tab; label: string }[] {
  if (role === "admin") {
    return [
      { id: "import", label: "Import" },
      { id: "history", label: "History" },
      { id: "users", label: "Users" },
      { id: "settings", label: "Settings" },
    ];
  }
  return [{ id: "account", label: "Account" }];
}

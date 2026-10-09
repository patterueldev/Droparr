import type { UserRole } from "@droparr/shared";

export type Tab =
  | "import"
  | "queue"
  | "history"
  | "users"
  | "settings"
  | "submit"
  | "account";

/**
 * Tabs each role can see. Admins get the full app (import, approval queue,
 * history, user management, settings); submitters get their submit view plus
 * their account.
 */
export function tabsForRole(role: UserRole): { id: Tab; label: string }[] {
  if (role === "admin") {
    return [
      { id: "import", label: "Import" },
      { id: "queue", label: "Queue" },
      { id: "history", label: "History" },
      { id: "users", label: "Users" },
      { id: "settings", label: "Settings" },
    ];
  }
  return [
    { id: "submit", label: "Submit" },
    { id: "account", label: "Account" },
  ];
}

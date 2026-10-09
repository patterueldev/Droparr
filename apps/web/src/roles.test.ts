import { describe, expect, it } from "vitest";
import { tabsForRole } from "./roles.js";

describe("tabsForRole", () => {
  it("shows admins the full app", () => {
    expect(tabsForRole("admin").map((tab) => tab.id)).toEqual([
      "import",
      "queue",
      "history",
      "users",
      "settings",
    ]);
  });

  it("shows submitters their submit view and account", () => {
    expect(tabsForRole("submitter").map((tab) => tab.id)).toEqual([
      "submit",
      "account",
    ]);
  });
});

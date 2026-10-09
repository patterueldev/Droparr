import { describe, expect, it } from "vitest";
import { tabsForRole } from "./roles.js";

describe("tabsForRole", () => {
  it("shows admins the full app", () => {
    expect(tabsForRole("admin").map((tab) => tab.id)).toEqual([
      "import",
      "history",
      "users",
      "settings",
    ]);
  });

  it("shows submitters only their account", () => {
    expect(tabsForRole("submitter")).toEqual([
      { id: "account", label: "Account" },
    ]);
  });
});

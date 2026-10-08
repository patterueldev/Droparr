import type { ZodError } from "zod";

/** Flatten zod issues into short human-readable lines. */
export function zodToReadableErrors(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

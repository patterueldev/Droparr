import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userRoleSchema, type User } from "@droparr/shared";
import type { AuthEvents } from "../auth/events.js";
import type { Db } from "../db.js";

const userPatchSchema = z
  .object({
    role: userRoleSchema.optional(),
    trusted: z.boolean().optional(),
    blocked: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "At least one of role, trusted or blocked is required",
  });

export interface UserRouteDeps {
  db: Db;
  authEvents: AuthEvents;
}

/**
 * Admin user management (#7): the access-control guard keeps every route here
 * admin-only. Role changes pin the user to Droparr (see `Db.updateUser`), and
 * blocking purges every session of that user — live sockets are told to close
 * immediately, and the next request from a stale cookie gets a 401.
 */
export function userRoutes(app: FastifyInstance, deps: UserRouteDeps): void {
  const { db, authEvents } = deps;

  app.get("/api/users", async (): Promise<User[]> => db.listUsers());

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
    const parsed = userPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const patch = parsed.data;

    // Lockout guards: no admin may block or demote themselves, and the last
    // active admin is protected for everyone (checked atomically in the DB).
    const self = req.auth!.user.id === req.params.id;
    if (self && (patch.blocked === true || patch.role === "submitter")) {
      return reply
        .code(400)
        .send({ error: "You cannot block or demote your own account" });
    }

    const result = db.updateUser(req.params.id, patch);
    if (!result.ok) {
      return result.error === "not-found"
        ? reply.code(404).send({ error: "User not found" })
        : reply.code(400).send({
            error: "The last administrator cannot be demoted or blocked",
          });
    }

    if (patch.blocked === true) {
      for (const session of db.deleteSessionsByUser(result.user.id)) {
        authEvents.emitSessionRevoked({
          sessionId: session.id,
          userId: result.user.id,
        });
      }
    }
    return result.user;
  });
}

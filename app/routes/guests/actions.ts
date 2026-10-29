import { data } from "react-router";
import * as v from "valibot";

import { authContext, guestsContext, invitationsContext } from "~/server/context";
import type { InvitationResult } from "~/server/guest-invitations";
import type { GuestResult } from "~/server/guests";
import { ActionError, createAction } from "~/server/web/actions";
import { isUserPrincipal } from "~/server/web/auth";
import { Capabilities } from "~/server/web/roles";
import { invalid, ok } from "~/utils/form";

import { guestFields, guestId, guestRevision } from "./schemas";

const status = { validation: 400, not_found: 404, conflict: 409, database: 503 } as const;

export function invitationData<T>(result: InvitationResult<T>): T {
  if (!result.ok) throw data(result.error.message, { status: invitationStatus[result.error.code] });
  return result.value;
}
export const invitationStatus = {
  unavailable: 400,
  rate_limited: 429,
  delivery_failed: 503,
  disabled: 503,
  conflict: 409,
  database: 503,
  validation: 400,
} as const;

function invitationSaved(result: InvitationResult<void>, message: string) {
  if (!result.ok) throw new ActionError(result.error.message, invitationStatus[result.error.code]);
  return ok(message);
}

export function guestData<T>(result: GuestResult<T>): T {
  if (!result.ok) throw data(result.error.message, { status: status[result.error.code] });
  return result.value;
}

function saved<T extends { id: string }>(result: GuestResult<T>, message: string) {
  if (!result.ok) {
    if (result.error.fields) return invalid(result.error.fields);
    throw new ActionError(result.error.message, status[result.error.code]);
  }
  return ok(message, { id: result.value.id });
}

export const createGuestAction = createAction({
  capability: Capabilities.manage_guests,
  async setup({ request, context }) {
    return {
      principal: await context.get(authContext).require(request),
      guests: context.get(guestsContext),
    };
  },
  intents: {
    create: {
      fields: guestFields,
      async handler(input, { guests, principal }) {
        return saved(
          guests.create(input, isUserPrincipal(principal) ? principal.user.id : null),
          "Guest draft created",
        );
      },
    },
  },
});

export const editGuestAction = createAction({
  capability: Capabilities.manage_guests,
  async setup({ request, context, params }) {
    return {
      principal: await context.get(authContext).require(request),
      guests: context.get(guestsContext),
      id: params.id ?? "",
      invitations: context.get(invitationsContext),
    };
  },
  intents: {
    update: {
      fields: { ...guestFields, revision: guestRevision },
      async handler(input, { guests, id }) {
        return saved(guests.update(id, input.revision, input), "Guest draft updated");
      },
    },
    revoke: {
      fields: { revision: guestRevision },
      async handler(input, { guests, id, invitations, principal }) {
        const existing = invitations.get(id);
        if (!existing.ok)
          throw new ActionError(existing.error.message, invitationStatus[existing.error.code]);
        if (existing.value.invitation) {
          return invitationSaved(
            invitations.revoke(
              id,
              input.revision,
              isUserPrincipal(principal) ? principal.user.id : null,
            ),
            "Invitation revoked",
          );
        }
        return saved(guests.revoke(id, input.revision), "Guest draft revoked");
      },
    },
    send_invitation: {
      fields: {
        revision: guestRevision,
        validity_hours: v.pipe(v.string(), v.regex(/^[1-9]\d{0,2}$/), v.transform(Number)),
      },
      async handler(input, { invitations, principal, id }) {
        return invitationSaved(
          await invitations.send(
            id,
            input.revision,
            input.validity_hours,
            isUserPrincipal(principal) ? principal.user.id : null,
          ),
          "Invitation sent",
        );
      },
    },
  },
});

export function parseGuestId(id: unknown) {
  const parsed = v.safeParse(guestId, id);
  if (!parsed.success) throw data("This guest no longer exists.", { status: 404 });
  return parsed.output;
}

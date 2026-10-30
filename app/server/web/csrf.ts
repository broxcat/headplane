import { ActionError } from "./actions";

// React Router guards the HTTP action transport. Keep sensitive actions guarded
// when invoked directly too, using the same origin comparison after runtime
// scheme alignment. Never trust forwarding headers here.
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (
    request.headers.get("Sec-Fetch-Site") === "cross-site" ||
    (origin !== null && origin !== new URL(request.url).origin)
  ) {
    throw new ActionError("Invalid request origin.", 403);
  }
}

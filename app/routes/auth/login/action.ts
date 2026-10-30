import { DrizzleQueryError } from "drizzle-orm";
import { data, redirect } from "react-router";

import {
  appConfigContext,
  authContext,
  headscaleContext,
  localAuthContext,
} from "~/server/context";
import { headscaleErrorMessage, isDataWithApiError } from "~/server/headscale/api/error-client";
import { ActionError } from "~/server/web/actions";
import { requireSameOrigin } from "~/server/web/csrf";
import log from "~/utils/log";

import type { Route } from "./+types/page";

export async function loginAction({ request, context }: Route.LoaderArgs) {
  const auth = context.get(authContext);
  const headscale = context.get(headscaleContext);

  try {
    requireSameOrigin(request);
  } catch (error) {
    if (error instanceof ActionError)
      return data({ success: false as const, message: error.message }, { status: error.status });
    throw error;
  }
  const formData = await request.formData();
  if (formData.get("method") === "local") {
    try {
      const config = context.get(appConfigContext);
      const local = context.get(localAuthContext);
      if (!config.auth?.local?.enabled || !local.available())
        throw new ActionError("Local authentication is unavailable.", 403);
      const username = formData.get("username");
      const password = formData.get("password");
      const result = await local.authenticate(
        typeof username === "string" ? username : "",
        typeof password === "string" ? password : "",
        auth.clientAddress(request),
      );
      if (!result.ok)
        throw new ActionError("Invalid credentials", result.error === "limited" ? 429 : 400);
      const cookie = await auth.createLocalSession(result.value.userId, result.value.revision);
      if (!cookie) throw new ActionError("Invalid credentials");
      log.info("auth", "Local authentication: login_succeeded (account %s)", result.value.userId);
      return redirect("/machines", { headers: { "Set-Cookie": cookie } });
    } catch (error) {
      if (error instanceof DrizzleQueryError) {
        log.error("auth", "Local authentication database operation failed");
        return data(
          { success: false as const, message: "Authentication is temporarily unavailable." },
          { status: 503 },
        );
      }
      if (error instanceof ActionError)
        return data({ success: false as const, message: error.message }, { status: error.status });
      throw error;
    }
  }
  const apiKey = formData.has("api_key") ? String(formData.get("api_key")).trim() : undefined;

  if (apiKey === undefined) {
    log.warn("auth", "Request made without API key");
    log.warn(
      "auth",
      "If this is unexpected, ensure your reverse proxy (if applicable) is configured correctly",
    );
    return {
      success: false,
      message: "Enter an API key.",
    };
  }

  if (apiKey.length === 0) {
    log.warn("auth", "Request made with empty API key");
    log.warn(
      "auth",
      "If this is unexpected, ensure your reverse proxy (if applicable) is configured correctly",
    );
    return {
      success: false,
      message: "Enter an API key.",
    };
  }

  // We need to make sure this is safe for HTTP headers
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    return {
      success: false,
      message: "That API key is invalid or has expired.",
    };
  }

  // Build a client with the candidate API key the user just submitted, so the
  // GET /api/v1/apikey call below validates the key against Headscale itself.
  const api = headscale.client(apiKey);
  try {
    const apiKeys = await api.apiKeys.list();

    // We don't need to check for 0 API keys because this request cannot
    // be authenticated correctly without an API key
    //
    // 0.28.0 pointlessly added asterisks to the prefixes of API keys, which is
    // the dumbest thing I've ever seen.
    const lookup = apiKeys.find((key) => apiKey.startsWith(key.prefix.replaceAll("*", "")));
    if (!lookup) {
      return {
        success: false,
        message: "That API key doesn't exist on this server.",
      };
    }

    if (lookup.expiration === null || lookup.expiration === undefined) {
      log.error("auth", "Got an API key without an expiration");
      return {
        success: false,
        message: "That API key has no expiration. Create a new one.",
      };
    }

    const expiry = new Date(lookup.expiration);
    if (expiry.getTime() < Date.now()) {
      return {
        success: false,
        message: "That API key has expired.",
      };
    }

    return redirect("/machines", {
      headers: {
        "Set-Cookie": await auth.createApiKeySession(
          apiKey,
          `${lookup.prefix}...`,
          expiry.getTime() - Date.now(),
        ),
      },
    });
  } catch (error) {
    // Check if this is a React Router DataWithResponseInit wrapping a Headscale API error
    if (isDataWithApiError(error)) {
      const apiError = error.data;
      // TODO: What in gods name is wrong with the headscale API?
      if (
        apiError.statusCode === 401 ||
        apiError.statusCode === 403 ||
        (apiError.statusCode === 500 && apiError.rawData.trim() === "Unauthorized")
      ) {
        return {
          success: false,
          message: "That API key is invalid or has expired.",
        };
      }
    }

    log.error(
      "auth",
      "Error while validating API key: %s",
      headscaleErrorMessage(error) ?? String(error),
    );
    log.debug("auth", "Error details: %o", error);
    return {
      success: false,
      message: "Couldn't check the API key. See the server logs.",
    };
  }
}

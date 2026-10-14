import { config } from "../config";

const GOOGLE_TIMEOUT_MS = 10_000;

/** The one redirect URI registered with Google; connector and admin sign-ins share it. */
export const GOOGLE_CALLBACK_PATH = "/auth/google/callback";

/** Google's account chooser for one sign-in, tied to it by `state`. */
export function googleConsentUrl(state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", `${config.baseUrl}${GOOGLE_CALLBACK_PATH}`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.href;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
}

export interface GoogleIdentity {
  sub: string;
  /** Verified by Google, as Google returned it. */
  email: string;
}

/** Exchange a Google authorization code for the verified identity behind it. */
export async function googleIdentityFromCode(code: string): Promise<GoogleIdentity> {
  const tokenRes = await fetch(config.googleTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: `${config.baseUrl}${GOOGLE_CALLBACK_PATH}`,
      grant_type: "authorization_code",
    }),
    // Sign-in steps of one request run one at a time; a hung call must not hold the rest.
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
  if (!tokenRes.ok) throw new Error(`google token endpoint returned ${tokenRes.status}`);
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("google response missing id_token");

  // The id_token arrived directly from Google's token endpoint over TLS,
  // so claim validation (not signature verification) is what matters here.
  const claims = decodeJwtPayload(tokens.id_token) as {
    iss?: string; aud?: string; exp?: number; sub?: string; email?: string; email_verified?: boolean;
  };
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw new Error("id_token issuer mismatch");
  }
  if (claims.aud !== config.googleClientId) throw new Error("id_token audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new Error("id_token expired");
  if (!claims.sub) throw new Error("id_token missing sub");
  if (!claims.email || claims.email_verified !== true) throw new Error("google email not verified");
  return { sub: claims.sub, email: claims.email };
}

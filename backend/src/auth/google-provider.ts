import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
  nonce: string;
}

export interface GoogleOAuthProvider {
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string;
  verifyAuthorizationCode(code: string, codeVerifier: string): Promise<GoogleProfile>;
}

export class GoogleOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

export function createGoogleOAuthProvider(config: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): GoogleOAuthProvider {
  const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);

  return {
    authorizationUrl({ state, nonce, codeChallenge }) {
      return client.generateAuthUrl({
        access_type: "online",
        include_granted_scopes: true,
        prompt: "select_account",
        response_type: "code",
        scope: ["openid", "email", "profile"],
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
      });
    },

    async verifyAuthorizationCode(code, codeVerifier) {
      try {
        const { tokens } = await client.getToken({ code, codeVerifier });
        if (!tokens.id_token) throw new GoogleOAuthError("Google did not return an identity token");

        const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
        const claims = ticket.getPayload();
        if (!claims?.sub || !claims.email || claims.email_verified !== true) {
          throw new GoogleOAuthError("Google returned incomplete or unverified account identity");
        }
        if (!claims.nonce) throw new GoogleOAuthError("Google identity token did not contain the OAuth nonce");

        return {
          sub: claims.sub,
          email: claims.email,
          name: claims.name?.trim() || claims.email,
          picture: claims.picture ?? null,
          nonce: claims.nonce,
        };
      } catch (error) {
        if (error instanceof GoogleOAuthError) throw error;
        throw new GoogleOAuthError("Google authorization code could not be verified");
      }
    },
  };
}

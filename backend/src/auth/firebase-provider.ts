import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { FirebaseIdentity, FirebaseTokenVerifier } from "./router.js";

/** Verifies Firebase client ID tokens against the configured Firebase project. */
export function createFirebaseTokenVerifier(projectId: string): FirebaseTokenVerifier {
  const app = getApps().find((candidate) => candidate.options.projectId === projectId)
    ?? initializeApp({ projectId }, `mailflow-auth-${projectId}`);
  const auth = getAuth(app);
  return {
    async verifyIdToken(token: string): Promise<FirebaseIdentity> {
      // Signature/issuer/audience/expiry are verified via Google's public certs.
      // MailFlow revokes its own application sessions; Firebase revocation lookups
      // would require a service credential that this verifier deliberately avoids.
      const claims = await auth.verifyIdToken(token);
      if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) {
        throw new Error("Firebase token issuer or audience mismatch");
      }
      return {
        uid: claims.uid,
        email: typeof claims.email === "string" ? claims.email : "",
        name: typeof claims.name === "string" ? claims.name : "",
        picture: typeof claims.picture === "string" ? claims.picture : null,
        emailVerified: claims.email_verified === true,
        signInProvider: typeof claims.firebase?.sign_in_provider === "string" ? claims.firebase.sign_in_provider : null,
      };
    },
  };
}

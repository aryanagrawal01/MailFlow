import { getApp, getApps, initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { frontendEnvironment } from "./env";

const { VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_APP_ID } = frontendEnvironment;
export const firebaseConfigured = Boolean(VITE_FIREBASE_API_KEY && VITE_FIREBASE_AUTH_DOMAIN && VITE_FIREBASE_PROJECT_ID && VITE_FIREBASE_APP_ID);

const firebaseApp = firebaseConfigured
  ? (getApps().length ? getApp() : initializeApp({
      apiKey: VITE_FIREBASE_API_KEY!,
      authDomain: VITE_FIREBASE_AUTH_DOMAIN!,
      projectId: VITE_FIREBASE_PROJECT_ID!,
      appId: VITE_FIREBASE_APP_ID!,
    }))
  : null;

const auth = firebaseApp ? getAuth(firebaseApp) : null;
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

export async function firebaseGoogleSignIn(): Promise<string> {
  if (!auth) throw new Error("Google sign-in is not configured yet. Set the Firebase web app values and rebuild the frontend.");
  const result = await signInWithPopup(auth, googleProvider);
  return result.user.getIdToken();
}

export async function firebaseSignOut(): Promise<void> {
  if (auth) await signOut(auth);
}

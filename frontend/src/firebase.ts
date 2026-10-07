import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";
import { getStorage, type FirebaseStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/** Set when frontend/.env is missing Firebase keys, so the app can explain instead of crashing. */
export const firebaseConfigError =
  firebaseConfig.apiKey && firebaseConfig.projectId
    ? ""
    : "Firebase is not configured. Copy the VITE_FIREBASE_* values into frontend/.env and restart the dev server.";

const app: FirebaseApp | null = firebaseConfigError
  ? null
  : initializeApp(firebaseConfig);

export const auth: Auth | null = app ? getAuth(app) : null;
/** Used for profile avatars. MongoDB stores only the download URL. */
export const storage: FirebaseStorage | null = app && firebaseConfig.storageBucket
  ? getStorage(app)
  : null;

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

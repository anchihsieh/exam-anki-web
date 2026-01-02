import { initializeApp, getApps } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// ✅ 只從環境變數讀（部署時由 Vercel 提供）
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// ✅ 避免 SSR/prerender 時初始化 Firebase（只在瀏覽器）
const isBrowser = typeof window !== "undefined";

export const app = isBrowser
  ? (getApps().length ? getApps()[0] : initializeApp(firebaseConfig))
  : null;

export const auth = isBrowser && app ? getAuth(app) : null;
export const db = isBrowser && app ? getFirestore(app) : null;

export async function ensureAnonAuth() {
  if (!auth) return;
  if (auth.currentUser) return;
  await signInAnonymously(auth);
}

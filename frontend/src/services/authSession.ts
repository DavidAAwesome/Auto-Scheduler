import { useSyncExternalStore } from 'react';
import {
  createUserWithEmailAndPassword, deleteUser, onAuthStateChanged, sendPasswordResetEmail,
  signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile, type User as FirebaseUser,
} from 'firebase/auth';
import { auth, firebaseConfigError, googleProvider } from '../firebase';
import { ApiError, apiRequest, setTokenProvider } from './api';
import { workspaceService } from './workspace';
export interface User { id: string; name: string; email: string; photoURL: string | null; provider: 'google' | 'password' }
type Session = { status: 'loading' | 'authenticated' | 'anonymous' | 'error'; user: User | null; error: string };
let session: Session = firebaseConfigError
  ? { status: 'error', user: null, error: firebaseConfigError }
  : { status: 'loading', user: null, error: '' };
const listeners = new Set<() => void>();
let started = false;
let revision = 0;
function publish(next: Session) {
  workspaceService.setUser(next.user?.id ?? null);
  session = next;
  listeners.forEach(listener => listener());
}
setTokenProvider(async () => auth?.currentUser ? auth.currentUser.getIdToken() : null);

/** Firebase confirms who the user is; the API confirms it accepts that identity before the app opens. */
async function syncWithServer(firebaseUser: FirebaseUser | null) {
  const current = ++revision;
  if (!firebaseUser) { publish({ status: 'anonymous', user: null, error: '' }); return; }
  if (session.status !== 'authenticated') publish({ status: 'loading', user: null, error: '' });
  try {
    const profile = await apiRequest<{ id: string; name: string; email: string }>('/auth/me');
    if (current !== revision) return;
    const provider = firebaseUser.providerData.some(p => p.providerId === 'google.com') ? 'google' : 'password';
    publish({ status: 'authenticated', user: { ...profile, photoURL: firebaseUser.photoURL, provider }, error: '' });
  } catch (error) {
    if (current !== revision) return;
    const message = error instanceof ApiError && error.status === 401
      ? 'The AutoPlan server rejected your sign-in. Check that FIREBASE_PROJECT_ID in backend/.env matches the frontend.'
      : (error as Error).message;
    publish({ status: 'error', user: null, error: message });
  }
}

function friendlyError(error: unknown) {
  const code = (error as { code?: string })?.code ?? '';
  const messages: Record<string, string> = {
    'auth/email-already-in-use': 'An account with this email already exists.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/weak-password': 'Password must be at least 8 characters.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/user-not-found': 'Incorrect email or password.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
    'auth/popup-closed-by-user': 'Google sign-in was closed before finishing.',
    'auth/cancelled-popup-request': 'Google sign-in was closed before finishing.',
    'auth/popup-blocked': 'Your browser blocked the Google sign-in window. Allow pop-ups and try again.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled in Firebase yet.',
    'auth/requires-recent-login': 'For security, sign out, sign back in, and then delete your account.',
    'auth/network-request-failed': 'Cannot reach Firebase. Check your internet connection.',
  };
  return new Error(messages[code] ?? (error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'));
}
function requireAuth() {
  if (!auth) throw new Error(firebaseConfigError);
  return auth;
}

export const authSession = {
  getSnapshot: () => session,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  initialize() {
    if (started || !auth) return;
    started = true;
    onAuthStateChanged(auth, user => { void syncWithServer(user); });
  },
  retry() { publish({ status: 'loading', user: null, error: '' }); return syncWithServer(auth?.currentUser ?? null); },
  async login(email: string, password: string) {
    try { await signInWithEmailAndPassword(requireAuth(), email, password); } catch (e) { throw friendlyError(e); }
  },
  async loginWithGoogle() {
    try { await signInWithPopup(requireAuth(), googleProvider); } catch (e) { throw friendlyError(e); }
  },
  async signup(name: string, email: string, password: string) {
    try {
      const { user } = await createUserWithEmailAndPassword(requireAuth(), email, password);
      await updateProfile(user, { displayName: name });
      await user.getIdToken(true); // Refresh so the server sees the new display name.
      await syncWithServer(user);
    } catch (e) { throw friendlyError(e); }
  },
  async resetPassword(email: string) {
    try { await sendPasswordResetEmail(requireAuth(), email); } catch (e) { throw friendlyError(e); }
  },
  async logout() {
    await signOut(requireAuth());
    window.location.hash = '/login';
  },
  /** Deletes AutoPlan data first, then the Firebase account, so no data outlives its owner. */
  async deleteAccount() {
    const user = requireAuth().currentUser;
    if (!user) throw new Error('Please sign in again.');
    try {
      await apiRequest<void>('/auth/account', { method: 'DELETE' });
      await deleteUser(user);
    } catch (e) { throw friendlyError(e); }
    window.location.hash = '/login';
  },
};
window.addEventListener('autoplan:unauthorized', () => {
  if (session.status === 'authenticated' && auth) void signOut(auth);
});
export function useAuth() { return useSyncExternalStore(authSession.subscribe, authSession.getSnapshot); }

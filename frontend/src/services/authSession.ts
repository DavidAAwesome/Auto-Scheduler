import { useSyncExternalStore } from 'react';
import {
  createUserWithEmailAndPassword, deleteUser, onAuthStateChanged, sendEmailVerification, sendPasswordResetEmail,
  signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile, type User as FirebaseUser,
} from 'firebase/auth';
import { auth, firebaseConfigError, googleProvider } from '../firebase';
import { ApiError, apiRequest, apiUrl, setTokenProvider } from './api';
import { prepareAvatar } from './avatarUpload';
import { workspaceService } from './workspace';
/** photoURL is what to show (uploaded avatar, else the Google photo); hasCustomAvatar is whether there's an upload to remove. */
export interface User {
  id: string; name: string; email: string; photoURL: string | null; hasCustomAvatar: boolean; provider: 'google' | 'password';
  /** From Firebase: whether the address is confirmed, and when the account was created (ISO), if known. */
  emailVerified: boolean; createdAt: string | null;
}
type ServerProfile = { id: string; name: string; email: string; avatarUrl?: string | null };
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
function toUser(profile: ServerProfile, firebaseUser: FirebaseUser): User {
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    photoURL: profile.avatarUrl ? apiUrl(profile.avatarUrl) : firebaseUser.photoURL,
    hasCustomAvatar: Boolean(profile.avatarUrl),
    provider: firebaseUser.providerData.some(p => p.providerId === 'google.com') ? 'google' : 'password',
    emailVerified: firebaseUser.emailVerified,
    createdAt: creationTime(firebaseUser),
  };
}
function creationTime(firebaseUser: FirebaseUser) {
  const value = firebaseUser.metadata?.creationTime;
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.valueOf()) ? parsed.toISOString() : null;
}
setTokenProvider(async () => auth?.currentUser ? auth.currentUser.getIdToken() : null);

/** Firebase confirms who the user is; the API confirms it accepts that identity before the app opens. */
async function syncWithServer(firebaseUser: FirebaseUser | null) {
  const current = ++revision;
  if (!firebaseUser) { publish({ status: 'anonymous', user: null, error: '' }); return; }
  if (session.status !== 'authenticated') publish({ status: 'loading', user: null, error: '' });
  try {
    const profile = await apiRequest<ServerProfile>('/auth/me');
    if (current !== revision) return;
    publish({ status: 'authenticated', user: toUser(profile, firebaseUser), error: '' });
  } catch (error) {
    if (current !== revision) return;
    const message = error instanceof ApiError && error.status === 401
      ? 'AutoPlan couldn’t confirm your sign-in. Please try again shortly.'
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
    'auth/requires-recent-login': 'For security, sign out, sign back in, and then try again.',
    'auth/network-request-failed': 'Cannot reach Firebase. Check your internet connection.',
  };
  return new Error(messages[code] ?? (error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'));
}
function avatarError(error: unknown) {
  const detail = error instanceof ApiError ? error.message : 'Something went wrong.';
  return new Error(`${detail.replace(/\.?$/, '.')} Your previous avatar is unchanged.`);
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
  /** Firebase owns the display name; the API copies it from the refreshed ID token, like at sign-up. */
  async updateName(name: string) {
    const firebaseUser = requireAuth().currentUser;
    if (!firebaseUser) throw new Error('Please sign in again.');
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Enter a name.');
    if (trimmed.length > 80) throw new Error('Use 80 characters or fewer.');
    try {
      await updateProfile(firebaseUser, { displayName: trimmed });
      await firebaseUser.getIdToken(true);
    } catch (e) { throw friendlyError(e); }
    let profile: ServerProfile;
    try { profile = await apiRequest<ServerProfile>('/auth/me'); } catch (e) { throw friendlyError(e); }
    publish({ status: 'authenticated', user: toUser(profile, firebaseUser), error: '' });
  },
  /** Sends Firebase's reset link to the signed-in address (the same flow as "Forgot password" on sign-in). */
  async sendPasswordReset() {
    const email = requireAuth().currentUser?.email;
    if (!email) throw new Error('Please sign in again.');
    try { await sendPasswordResetEmail(requireAuth(), email); } catch (e) { throw friendlyError(e); }
    return email;
  },
  async sendVerificationEmail() {
    const firebaseUser = requireAuth().currentUser;
    if (!firebaseUser) throw new Error('Please sign in again.');
    try { await sendEmailVerification(firebaseUser); } catch (e) { throw friendlyError(e); }
  },
  /** Re-reads Firebase's copy of the account, e.g. after the user clicks a verification link elsewhere. */
  async refreshAccount() {
    const firebaseUser = auth?.currentUser;
    if (!firebaseUser || session.status !== 'authenticated' || !session.user) return;
    try { await firebaseUser.reload(); } catch { return; }
    if (session.status === 'authenticated' && session.user)
      publish({ ...session, user: { ...session.user, emailVerified: firebaseUser.emailVerified, createdAt: creationTime(firebaseUser) } });
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
  /**
   * Upload flow: picked file → resized JPEG → PUT /auth/avatar (the API validates and stores it)
   * → shared state from the server's profile. Nothing changes locally unless the server saved it.
   */
  async setAvatar(file: File) {
    const firebaseUser = requireAuth().currentUser;
    if (!firebaseUser) throw new Error('Please sign in again.');
    const image = await prepareAvatar(file);
    let profile: ServerProfile;
    try {
      profile = await apiRequest<ServerProfile>('/auth/avatar', { method: 'PUT', headers: { 'Content-Type': image.type }, body: image });
    } catch (e) { throw avatarError(e); }
    if (!profile.avatarUrl) throw new Error('The server did not confirm your new avatar. Your previous avatar is unchanged; try again.');
    publish({ status: 'authenticated', user: toUser(profile, firebaseUser), error: '' });
  },
  async clearAvatar() {
    const firebaseUser = requireAuth().currentUser;
    if (!firebaseUser) throw new Error('Please sign in again.');
    let profile: ServerProfile;
    try { profile = await apiRequest<ServerProfile>('/auth/avatar', { method: 'DELETE' }); } catch (e) { throw avatarError(e); }
    publish({ status: 'authenticated', user: toUser(profile, firebaseUser), error: '' });
  },
};
window.addEventListener('autoplan:unauthorized', () => {
  if (session.status === 'authenticated' && auth) void signOut(auth);
});
export function useAuth() { return useSyncExternalStore(authSession.subscribe, authSession.getSnapshot); }

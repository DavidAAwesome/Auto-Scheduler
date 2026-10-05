import { useSyncExternalStore } from 'react';
import { ApiError, apiRequest } from './api';
import { workspaceService } from './workspace';
export interface User { id: string; name: string; email: string }
type Session = { status: 'loading' | 'authenticated' | 'anonymous' | 'error'; user: User | null; error: string };
let session: Session = { status: 'loading', user: null, error: '' };
const listeners = new Set<() => void>();
let initialization: Promise<void> | undefined;
let revision = 0;
function publish(next: Session) {
  workspaceService.setUser(next.user?.id ?? null);
  session = next;
  listeners.forEach(listener => listener());
}
export const authSession = {
  getSnapshot: () => session,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  initialize() {
    if (initialization) return initialization;
    const current = ++revision;
    initialization = apiRequest<User>('/auth/me').then(user => { if (current === revision) publish({status:'authenticated',user,error:''}); }).catch(error => {
      if (current === revision) publish({status: error instanceof ApiError && error.status === 401 ? 'anonymous' : 'error', user:null, error:error.message});
    });
    return initialization;
  },
  retry() { initialization = undefined; publish({status:'loading',user:null,error:''}); return this.initialize(); },
  async login(email: string, password: string) {
    const current = ++revision;
    const user = await apiRequest<User>('/auth/login', {method:'POST',body:JSON.stringify({email,password})});
    if(current === revision) publish({status:'authenticated',user,error:''});
  },
  async signup(name: string, email: string, password: string) {
    const current = ++revision;
    const user = await apiRequest<User>('/auth/signup', {method:'POST',body:JSON.stringify({name,email,password})});
    if(current === revision) publish({status:'authenticated',user,error:''});
  },
  async logout() {
    ++revision;
    await apiRequest<void>('/auth/logout', {method:'POST'});
    publish({status:'anonymous',user:null,error:''});
    window.location.hash = '/login';
  },
};
window.addEventListener('autoplan:unauthorized', () => {
  // Let initial /me handling finish its request; later expiry clears the UI.
  if(session.status === 'authenticated') { ++revision; publish({status:'anonymous',user:null,error:''}); }
});
export function useAuth() { return useSyncExternalStore(authSession.subscribe,authSession.getSnapshot); }

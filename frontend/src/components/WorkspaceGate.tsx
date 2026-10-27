import type { ReactNode } from 'react';
import { useWorkspace } from '../hooks/useWorkspace';
import { workspaceService } from '../services/workspace';
export default function WorkspaceGate({ children }: { children: ReactNode }) {
  const { status, error } = useWorkspace();
  if (status === 'error') return <section className="card"><h2>Couldn’t load your workspace</h2><p role="alert">{error}</p><button className="button" onClick={() => void workspaceService.load()}>Try again</button></section>;
  if (status !== 'ready') return <section className="card"><p role="status">Loading your tasks and availability…</p></section>;
  return children;
}

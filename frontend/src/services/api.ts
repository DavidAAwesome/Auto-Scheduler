const API_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`${API_URL}${path}`, { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...options.headers } }); }
  catch { throw new ApiError('Cannot reach AutoPlan. Check that the backend is running and try again.', 0); }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/signup') window.dispatchEvent(new Event('autoplan:unauthorized'));
    const detail = data?.detail;
    const message = typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((item: {msg?: string}) => item.msg || 'Invalid input').join(' ') : 'Something went wrong. Please try again.';
    throw new ApiError(message, response.status);
  }
  return data as T;
}

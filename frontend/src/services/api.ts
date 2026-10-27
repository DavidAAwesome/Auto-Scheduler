const API_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
/** Supplies the signed-in user's Firebase ID token; registered by authSession to keep this module SDK-free. */
let getToken: () => Promise<string | null> = async () => null;
export function setTokenProvider(provider: () => Promise<string | null>) { getToken = provider; }
export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    const token = await getToken();
    response = await fetch(`${API_URL}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  }
  catch { throw new ApiError('Cannot reach AutoPlan. Check that the backend is running and try again.', 0); }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('autoplan:unauthorized'));
    const detail = data?.detail;
    const message = typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map((item: {msg?: string}) => item.msg || 'Invalid input').join(' ') : 'Something went wrong. Please try again.';
    throw new ApiError(message, response.status);
  }
  return data as T;
}

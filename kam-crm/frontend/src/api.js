// Minimal API client. VITE_API_URL points at the backend in production;
// during "npm run dev" the Vite proxy forwards /api to localhost:4000.
const BASE = import.meta.env.VITE_API_URL || "";

let token = sessionStorage.getItem("kamcrm_token") || "";

export function setToken(next) {
  token = next || "";
  if (token) sessionStorage.setItem("kamcrm_token", token);
  else sessionStorage.removeItem("kamcrm_token");
}

export function getToken() {
  return token;
}

export async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body?.error || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

/**
 * Auth Helper
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides a cached JWT token for API test requests.
 */

import { BASE_URL, USERS } from "../config.js";

let cachedToken: string | null = null;

export async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  const res = await fetch(`${BASE_URL}/auth/login`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      email:    USERS.superAdmin.email,
      password: USERS.superAdmin.password,
    }),
  });

  if (!res.ok) throw new Error(`Login failed: ${res.status}`);

  const json = (await res.json()) as { data: { accessToken: string } };
  cachedToken = json.data.accessToken;
  return cachedToken;
}

export function clearTokenCache(): void {
  cachedToken = null;
}

/** Typed fetch wrapper that injects the Bearer token automatically */
export async function api(
  path: string,
  options: RequestInit = {},
  withAuth = true,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (withAuth) {
    headers["Authorization"] = `Bearer ${await getToken()}`;
  }

  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

import { cookies } from "next/headers";

export async function apiFetch(path: string, init: RequestInit = {}) {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('accessToken')?.value;

  return fetch(`${process.env.API_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    cache:'no-store'
  });
}

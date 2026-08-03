export const ACCESS_TOKEN_MAX_AGE = 60 * 15;
export const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 7;

const baseOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

interface CookieSetter {
  set(name: string, value: string, options?: typeof baseOptions & { maxAge: number }): unknown;
}

export function setAuthCookies(store: CookieSetter, accessToken: string, refreshToken: string) {
  store.set('accessToken', accessToken, { ...baseOptions, maxAge: ACCESS_TOKEN_MAX_AGE });
  store.set('refreshToken', refreshToken, { ...baseOptions, maxAge: REFRESH_TOKEN_MAX_AGE });
}

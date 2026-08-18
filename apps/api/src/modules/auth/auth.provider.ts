import type { Role } from '@vaep/types';

/** JWT claims carried in both access and refresh tokens. */
export interface JwtPayload {
  /** userId */
  sub: string;
  companyId: string;
  role: Role;
}

/** Shape attached to `req.user` after the JwtAuthGuard runs. */
export interface AuthenticatedUser {
  userId: string;
  companyId: string;
  role: Role;
  email: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Auth is implemented behind this interface so the self-hosted JWT provider can
 * later be swapped for Clerk/Auth0 without touching AuthService/controllers.
 */
export interface AuthProvider {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  issueTokens(payload: JwtPayload): Promise<TokenPair>;
  verifyRefresh(token: string): Promise<JwtPayload>;
}

/** DI token for the active AuthProvider implementation. */
export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');

/** Name of the httpOnly refresh cookie. */
export const REFRESH_COOKIE = 'vaep_refresh';

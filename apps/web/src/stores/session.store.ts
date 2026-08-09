import { create } from 'zustand';
import type { CompanyDto, UserDto } from '@vaep/types';

/**
 * The ONE Zustand store for the app. Holds a `session` slice (auth identity used
 * by the axios interceptor and route guards) and a small `ui` slice. There is
 * intentionally a single store instance for the whole client.
 *
 * `status` drives the route guards:
 *   - 'loading'        → session is being rehydrated on app load (silent refresh)
 *   - 'authenticated'  → we hold a valid access token + identity
 *   - 'guest'          → no session (or rehydrate failed)
 * Guards MUST wait for `status !== 'loading'` before redirecting, otherwise a
 * hard refresh (which resets in-memory state) bounces the user to /login before
 * the httpOnly refresh cookie can restore the session.
 */
export type SessionStatus = 'loading' | 'authenticated' | 'guest';

interface SessionState {
  user: UserDto | null;
  company: CompanyDto | null;
  accessToken: string | null;
  status: SessionStatus;
}

interface UiState {
  /** Example of a global UI flag living alongside session state. */
  sidebarOpen: boolean;
}

interface Actions {
  setSession: (payload: {
    user: UserDto;
    company: CompanyDto;
    accessToken: string;
  }) => void;
  setAccessToken: (token: string | null) => void;
  setCompany: (company: CompanyDto) => void;
  setStatus: (status: SessionStatus) => void;
  setUi: (partial: Partial<UiState>) => void;
  clear: () => void;
}

export type SessionStore = SessionState & UiState & Actions;

const initialState: SessionState & UiState = {
  user: null,
  company: null,
  accessToken: null,
  status: 'loading',
  sidebarOpen: true,
};

export const useSessionStore = create<SessionStore>((set) => ({
  ...initialState,
  setSession: ({ user, company, accessToken }) =>
    set({ user, company, accessToken, status: 'authenticated' }),
  setAccessToken: (accessToken) => set({ accessToken }),
  setCompany: (company) => set({ company }),
  setStatus: (status) => set({ status }),
  setUi: (partial) => set(partial),
  clear: () =>
    set({ user: null, company: null, accessToken: null, status: 'guest' }),
}));

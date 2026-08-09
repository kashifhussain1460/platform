'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AuthResponse,
  LoginDto,
  MeDto,
  RegisterDto,
} from '@vaep/types';
import type { NormalizedApiError } from '@/lib/apiClient';
import { useSessionStore } from '@/stores/session.store';
import {
  forgotPasswordRequest,
  verifyResetOtpRequest,
  loginRequest,
  logoutRequest,
  meRequest,
  registerRequest,
  resendVerificationRequest,
  resetPasswordRequest,
  verifyEmailRequest,
} from './api';

export const authKeys = {
  me: ['auth', 'me'] as const,
};

interface MutationContext {
  previous?: MeDto | null;
}

/** Current user query — enabled only when we hold an access token. */
export function useCurrentUser() {
  const accessToken = useSessionStore((s) => s.accessToken);
  return useQuery<MeDto, NormalizedApiError>({
    queryKey: authKeys.me,
    queryFn: meRequest,
    enabled: Boolean(accessToken),
    staleTime: 60_000,
  });
}

function useAuthSuccess() {
  const qc = useQueryClient();
  const setSession = useSessionStore((s) => s.setSession);
  return (data: AuthResponse) => {
    setSession({
      user: data.user,
      company: data.company,
      accessToken: data.tokens.accessToken,
    });
    // Prime the /auth/me cache optimistically from the auth response.
    qc.setQueryData<MeDto>(authKeys.me, {
      user: data.user,
      company: data.company,
    });
  };
}

/**
 * Login mutation using the required optimistic pattern:
 * onMutate snapshots the me-cache, onError rolls back + clears session,
 * onSettled invalidates so the server value re-syncs.
 */
/** Confirm the emailed OTP, then refresh identity so guards see emailVerified. */
export function useVerifyEmail() {
  const qc = useQueryClient();
  const setSession = useSessionStore((s) => s.setSession);
  const accessToken = useSessionStore((s) => s.accessToken);
  return useMutation<{ verified: boolean }, NormalizedApiError, string>({
    mutationFn: (code) => verifyEmailRequest(code),
    onSuccess: async () => {
      const me = await meRequest();
      if (accessToken) {
        setSession({ user: me.user, company: me.company, accessToken });
      }
      void qc.invalidateQueries({ queryKey: authKeys.me });
    },
  });
}

/** Re-send the verification OTP (server enforces a cooldown). */
export function useResendVerification() {
  return useMutation<{ sent: boolean }, NormalizedApiError, void>({
    mutationFn: () => resendVerificationRequest(),
  });
}

/** Request a reset link. Server responds generically (never reveals existence). */
export function useForgotPassword() {
  return useMutation<{ ok: true }, NormalizedApiError, string>({
    mutationFn: (email) => forgotPasswordRequest(email),
  });
}

/** Verify the reset OTP → single-use token for the reset-password step. */
export function useVerifyResetOtp() {
  return useMutation<
    { token: string },
    NormalizedApiError,
    { email: string; code: string }
  >({
    mutationFn: ({ email, code }) => verifyResetOtpRequest(email, code),
  });
}

/** Set a new password from the single-use reset token. */
export function useResetPassword() {
  return useMutation<{ ok: true }, NormalizedApiError, { token: string; password: string }>({
    mutationFn: ({ token, password }) => resetPasswordRequest(token, password),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  const clear = useSessionStore((s) => s.clear);
  const onSuccess = useAuthSuccess();

  return useMutation<AuthResponse, NormalizedApiError, LoginDto, MutationContext>({
    mutationFn: loginRequest,
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: authKeys.me });
      const previous = qc.getQueryData<MeDto>(authKeys.me);
      return { previous };
    },
    onSuccess,
    onError: (_err, _vars, context) => {
      clear();
      if (context?.previous) {
        qc.setQueryData(authKeys.me, context.previous);
      } else {
        qc.removeQueries({ queryKey: authKeys.me });
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: authKeys.me });
    },
  });
}

export function useRegister() {
  const qc = useQueryClient();
  const clear = useSessionStore((s) => s.clear);
  const onSuccess = useAuthSuccess();

  return useMutation<AuthResponse, NormalizedApiError, RegisterDto, MutationContext>({
    mutationFn: registerRequest,
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: authKeys.me });
      const previous = qc.getQueryData<MeDto>(authKeys.me);
      return { previous };
    },
    onSuccess,
    onError: (_err, _vars, context) => {
      clear();
      if (context?.previous) {
        qc.setQueryData(authKeys.me, context.previous);
      } else {
        qc.removeQueries({ queryKey: authKeys.me });
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: authKeys.me });
    },
  });
}

/**
 * Logout mutation — optimistically clears the session immediately, rolls back
 * on error, and invalidates to settle.
 */
export function useLogout() {
  const qc = useQueryClient();
  const clear = useSessionStore((s) => s.clear);

  return useMutation<void, NormalizedApiError, void, MutationContext>({
    mutationFn: logoutRequest,
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: authKeys.me });
      const previous = qc.getQueryData<MeDto>(authKeys.me);
      clear();
      qc.setQueryData(authKeys.me, null);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(authKeys.me, context.previous);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: authKeys.me });
    },
  });
}

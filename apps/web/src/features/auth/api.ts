import { apiClient } from '@/lib/apiClient';
import type {
  AuthResponse,
  LoginDto,
  MeDto,
  RegisterDto,
} from '@vaep/types';

export async function registerRequest(
  payload: RegisterDto,
): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>('/auth/register', payload);
  return data;
}

export async function loginRequest(payload: LoginDto): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>('/auth/login', payload);
  return data;
}

export async function meRequest(): Promise<MeDto> {
  const { data } = await apiClient.get<MeDto>('/auth/me');
  return data;
}

export async function verifyEmailRequest(code: string): Promise<{ verified: boolean }> {
  const { data } = await apiClient.post<{ verified: boolean }>('/auth/verify-email', {
    code,
  });
  return data;
}

export async function resendVerificationRequest(): Promise<{ sent: boolean }> {
  const { data } = await apiClient.post<{ sent: boolean }>('/auth/resend-verification');
  return data;
}

export async function forgotPasswordRequest(email: string): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>('/auth/forgot-password', {
    email,
  });
  return data;
}

export async function verifyResetOtpRequest(
  email: string,
  code: string,
): Promise<{ token: string }> {
  const { data } = await apiClient.post<{ token: string }>('/auth/verify-reset-otp', {
    email,
    code,
  });
  return data;
}

export async function resetPasswordRequest(
  token: string,
  password: string,
): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>('/auth/reset-password', {
    token,
    password,
  });
  return data;
}

export async function logoutRequest(): Promise<void> {
  // Clears the httpOnly refresh cookie server-side -- without this call, the
  // still-valid cookie let AuthBootstrap silently re-authenticate the user on
  // the very next full page load, making "logout" appear to redirect back
  // into the app instead of actually logging out.
  await apiClient.post('/auth/logout');
}

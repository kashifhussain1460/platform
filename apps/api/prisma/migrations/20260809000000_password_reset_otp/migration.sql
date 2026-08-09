-- OTP-based password recovery: a reset code (parallel to the email-verification
-- OTP) stored hashed + time-limited on the user. forgot-password issues it;
-- verify-reset-otp checks it and mints a single-use PasswordResetToken.
ALTER TABLE "User" ADD COLUMN "passwordResetCodeHash" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordResetCodeExpiresAt" TIMESTAMP(3);

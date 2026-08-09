import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AUTH_PROVIDER } from './auth.provider';
import { JwtAuthProvider } from './jwt-auth.provider';
import { JwtStrategy } from './jwt.strategy';
import { BillingModule } from '../billing/billing.module';
import { MailModule } from '../mail/mail.module';

@Module({
  // BillingModule (exports BillingService) lets register create a default
  // subscription. MailModule sends verification OTPs. Neither imports AuthModule
  // → no cycle.
  imports: [PassportModule, JwtModule.register({}), BillingModule, MailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    // Swap this useClass to change the auth backend (Clerk/Auth0) later.
    { provide: AUTH_PROVIDER, useClass: JwtAuthProvider },
  ],
  // Export AUTH_PROVIDER so UsersModule can reuse the SAME password hashing
  // (argon2) when creating users — no duplicate hashing implementation.
  exports: [AuthService, AUTH_PROVIDER],
})
export class AuthModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * User Management module (RBAC, P0 governance). Imports AuthModule to reuse the
 * exported AUTH_PROVIDER (argon2 password hashing) — no duplicate hashing. The
 * JwtAuthGuard/RolesGuard work because the JWT passport strategy is registered
 * globally by AuthModule; AuthModule does NOT import UsersModule → no cycle.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

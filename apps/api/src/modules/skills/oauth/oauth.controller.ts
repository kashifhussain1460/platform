import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { OAuthAuthorizeDto } from '@vaep/types';
import { CurrentTenant } from '../../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/auth.provider';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { OAuthService } from './oauth.service';

/**
 * OAuth authorization-code endpoints for `oauth` catalog skills. `authorize` is
 * JWT-guarded (OWNER/ADMIN) and returns the provider URL the browser should be
 * sent to; `callback` is deliberately PUBLIC (no JwtAuthGuard) — the provider
 * redirects the user's browser here with only `code` + our signed `state`, from
 * which the tenant is recovered. Lives on the `skills` path but carries no
 * class-level guard so the callback stays open.
 */
@Controller('skills')
export class SkillsOAuthController {
  constructor(private readonly oauth: OAuthService) {}

  /**
   * Build the provider authorize URL (signed state) for an installed skill.
   * `returnTo` (optional, same-origin relative path e.g. `/assist/<id>`) is
   * carried in the signed state so an in-chat connect resumes where it began.
   */
  @Get('installed/:id/oauth/authorize')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OWNER', 'ADMIN')
  async authorize(
    @CurrentTenant() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('returnTo') returnTo?: string,
  ): Promise<OAuthAuthorizeDto> {
    const url = await this.oauth.buildAuthorizeUrl(companyId, id, {
      returnTo,
      userId: user.userId,
    });
    return { url };
  }

  /** PUBLIC provider redirect target: exchange the code, then bounce to the web app. */
  @Get('oauth/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const redirectUrl = await this.oauth.handleCallback(code, state);
    res.redirect(302, redirectUrl);
  }
}

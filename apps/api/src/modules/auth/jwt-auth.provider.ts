import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { AuthProvider, JwtPayload, TokenPair } from './auth.provider';

/**
 * Self-hosted JWT + argon2 implementation of AuthProvider.
 * Access token is short-lived; refresh token is long-lived (stored as an
 * httpOnly cookie by the controller).
 */
@Injectable()
export class JwtAuthProvider implements AuthProvider {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password);
  }

  verify(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }

  async issueTokens(payload: JwtPayload): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('ACCESS_TTL') ?? '900s',
    });
    // A unique `jti` per refresh token: `iat`/`exp` are second-granular, so two
    // issuances in the same second (register→login, login→refresh rotation)
    // would otherwise be byte-identical and collide on the RefreshToken store's
    // unique tokenHash. The jti makes every refresh token distinct.
    const refreshToken = await this.jwt.signAsync(
      { ...payload, jti: randomUUID() },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.config.get<string>('REFRESH_TTL') ?? '7d',
      },
    );
    return { accessToken, refreshToken };
  }

  verifyRefresh(token: string): Promise<JwtPayload> {
    return this.jwt.verifyAsync<JwtPayload>(token, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
    });
  }
}

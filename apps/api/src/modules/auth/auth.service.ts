import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Company, User } from '@prisma/client';
import type {
  AuthResponse,
  CompanyDto,
  MeDto,
  UserDto,
} from '@vaep/types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BillingService } from '../billing/billing.service';
import {
  AUTH_PROVIDER,
  type AuthProvider,
  type JwtPayload,
} from './auth.provider';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/** Result bundle: the JSON body plus the refresh token the controller cookies. */
export interface AuthOutcome {
  response: AuthResponse;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    private readonly billing: BillingService,
  ) {}

  /** Register creates the Company + owner User atomically, then issues tokens. */
  async register(dto: RegisterDto): Promise<AuthOutcome> {
    this.logger.log(`register: start companyName="${dto.companyName}" email="${dto.email}"`);

    const slug = await this.uniqueSlug(dto.companyName);
    this.logger.log(`register: slug resolved slug="${slug}"`);

    const passwordHash = await this.auth.hash(dto.password);
    this.logger.log('register: password hashed');

    const { company, user } = await this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: dto.companyName,
          slug,
          industry: dto.industry ?? null,
          size: dto.size ?? null,
          country: dto.country ?? null,
          timezone: dto.timezone ?? null,
          website: dto.website ?? null,
          logoUrl: dto.logoUrl ?? null,
          description: dto.description ?? null,
        },
      });
      const user = await tx.user.create({
        data: {
          companyId: company.id,
          email: dto.email,
          name: dto.name,
          phone: dto.phone ?? null,
          passwordHash,
          role: 'OWNER',
        },
      });
      return { company, user };
    });
    this.logger.log(`register: company+user created companyId=${company.id} userId=${user.id}`);

    // Give the new company a default STARTER/ACTIVE subscription (Step 1).
    // Idempotent; response structure is unchanged.
    try {
      await this.billing.ensureDefaultSubscription(company.id);
      this.logger.log(`register: default subscription ensured companyId=${company.id}`);
    } catch (err) {
      this.logger.error(
        `register: ensureDefaultSubscription failed companyId=${company.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }

    const outcome = await this.buildOutcome(user, company);
    this.logger.log(`register: complete userId=${user.id}`);
    return outcome;
  }

  async login(dto: LoginDto): Promise<AuthOutcome> {
    this.logger.log(`login: start email="${dto.email}"`);

    // NOTE: email is unique per-company, not global. For this slice we resolve
    // by email alone; a later pass adds company-scoped login (slug/subdomain).
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email },
    });
    if (!user) {
      this.logger.warn(`login: no user found email="${dto.email}"`);
      throw new UnauthorizedException('Invalid credentials');
    }
    this.logger.log(`login: user found userId=${user.id}`);

    const ok = await this.auth.verify(user.passwordHash, dto.password);
    if (!ok) {
      this.logger.warn(`login: password mismatch userId=${user.id}`);
      throw new UnauthorizedException('Invalid credentials');
    }
    this.logger.log(`login: password verified userId=${user.id}`);

    // Disabled accounts may hold valid credentials but must not authenticate.
    if (user.status === 'DISABLED') {
      this.logger.warn(`login: account disabled userId=${user.id}`);
      throw new UnauthorizedException('Account is disabled');
    }
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: user.companyId },
    });
    const outcome = await this.buildOutcome(user, company);
    this.logger.log(`login: complete userId=${user.id}`);
    return outcome;
  }

  async refresh(refreshToken: string | undefined): Promise<AuthOutcome> {
    this.logger.log('refresh: start');
    if (!refreshToken) {
      this.logger.warn('refresh: missing refresh token cookie');
      throw new UnauthorizedException('Missing refresh token');
    }
    let payload: JwtPayload;
    try {
      payload = await this.auth.verifyRefresh(refreshToken);
    } catch {
      this.logger.warn('refresh: refresh token failed verification');
      throw new UnauthorizedException('Invalid refresh token');
    }
    this.logger.log(`refresh: token verified userId=${payload.sub}`);

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      this.logger.warn(`refresh: user no longer exists userId=${payload.sub}`);
      throw new UnauthorizedException('User no longer exists');
    }
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: user.companyId },
    });
    const outcome = await this.buildOutcome(user, company);
    this.logger.log(`refresh: complete userId=${user.id}`);
    return outcome;
  }

  async me(userId: string): Promise<MeDto> {
    this.logger.log(`me: start userId=${userId}`);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: user.companyId },
    });
    this.logger.log(`me: complete userId=${userId}`);
    return { user: toUserDto(user), company: toCompanyDto(company) };
  }

  private async buildOutcome(user: User, company: Company): Promise<AuthOutcome> {
    const payload: JwtPayload = {
      sub: user.id,
      companyId: user.companyId,
      role: user.role,
    };
    let accessToken: string;
    let refreshToken: string;
    try {
      ({ accessToken, refreshToken } = await this.auth.issueTokens(payload));
    } catch (err) {
      this.logger.error(
        `buildOutcome: issueTokens failed userId=${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }
    this.logger.log(`buildOutcome: tokens issued userId=${user.id}`);
    const response: AuthResponse = {
      user: toUserDto(user),
      company: toCompanyDto(company),
      tokens: { accessToken },
    };
    return { response, refreshToken };
  }

  private slugify(name: string): string {
    const base = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return base || 'company';
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = this.slugify(name);
    let slug = base;
    for (let i = 0; i < 5; i += 1) {
      const exists = await this.prisma.company.findUnique({ where: { slug } });
      if (!exists) {
        return slug;
      }
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}

function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    companyId: user.companyId,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

function toCompanyDto(company: Company): CompanyDto {
  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    industry: company.industry,
    size: company.size,
    country: company.country,
    timezone: company.timezone,
    website: company.website,
    logoUrl: company.logoUrl,
    description: company.description,
    onboardedAt: company.onboardedAt ? company.onboardedAt.toISOString() : null,
    createdAt: company.createdAt.toISOString(),
  };
}

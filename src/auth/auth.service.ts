import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types';

export const AUTH_COOKIE = 'auth-token';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        password: true,
        teamCode: true,
        canModerate: true,
      },
    });

    if (!user) throw new UnauthorizedException('Email hoac mat khau khong chinh xac');
    if (!user.isActive) throw new ForbiddenException('Tai khoan da bi vo hieu hoa');

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) throw new UnauthorizedException('Email hoac mat khau khong chinh xac');

    const { password: _password, ...safeUser } = user;
    const token = await this.signToken({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      teamCode: user.teamCode,
      canModerate: user.canModerate,
    });

    return { user: safeUser, token };
  }

  async signToken(payload: AuthUser) {
    return this.jwt.signAsync(payload, {
      secret: this.getJwtSecret(),
      expiresIn: '30d',
      algorithm: 'HS256',
    });
  }

  async verifyToken(token?: string): Promise<AuthUser | null> {
    if (!token) return null;
    try {
      const payload = await this.jwt.verifyAsync<AuthUser>(token, {
        secret: this.getJwtSecret(),
      });
      return payload;
    } catch {
      return null;
    }
  }

  async getActiveUser(payload: AuthUser) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        teamCode: true,
        canModerate: true,
        createdAt: true,
      },
    });
    if (!user || !user.isActive) throw new ForbiddenException('Tai khoan khong ton tai hoac da bi vo hieu hoa');
    return user;
  }

  async ensureRole(userId: string, roles: Role[]) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, isActive: true },
    });
    if (!user || !user.isActive) throw new ForbiddenException('Tai khoan khong hop le');
    if (!roles.includes(user.role)) throw new ForbiddenException('Khong co quyen truy cap');
    return user;
  }

  cookieOptions() {
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';
    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
      path: '/',
      maxAge: 1000 * 60 * 60 * 24 * 30,
    };
  }

  private getJwtSecret() {
    return this.config.get<string>('JWT_SECRET') || 'vinachina-kesa-secret-2026';
  }
}

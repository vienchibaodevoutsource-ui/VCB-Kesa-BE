import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AUTH_COOKIE, AuthService } from '../../auth/auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const bearer = request.header('authorization')?.replace(/^Bearer\s+/i, '');
    const token = request.cookies?.[AUTH_COOKIE] || bearer;
    const payload = await this.auth.verifyToken(token);
    if (!payload) throw new UnauthorizedException('Unauthorized');
    request.user = payload;
    return true;
  }
}

import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types';
import { AuthGuard } from '../common/guards/auth.guard';
import { AUTH_COOKIE, AuthService } from './auth.service';
import { LoginDto } from './dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(dto.email, dto.password);
    response.cookie(AUTH_COOKIE, result.token, this.auth.cookieOptions());
    return { data: { user: result.user } };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(AUTH_COOKIE, { path: '/' });
    return { data: { success: true } };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    return { data: { user: await this.auth.getActiveUser(user) } };
  }
}

import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/types';
import { CreateUserDto, UpdateUserDto } from './dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.users.list(query);
  }

  @Post()
  async create(@Body() dto: CreateUserDto) {
    return { data: await this.users.create(dto) };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthUser) {
    return { data: await this.users.update(id, dto, user) };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return { data: await this.users.remove(id) };
  }
}

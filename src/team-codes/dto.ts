import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateTeamCodeDto {
  @IsString()
  code!: string;

  @IsOptional()
  @IsString()
  label?: string;
}

export class UpdateTeamCodeDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

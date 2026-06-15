import { CompanyType } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';

export class SaveCompanyDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  chineseName?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsEnum(CompanyType)
  type!: CompanyType;

  @IsOptional()
  @IsString()
  formType?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  brokerCompanyId?: string;
}

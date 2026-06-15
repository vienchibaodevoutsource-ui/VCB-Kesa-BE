import { IsObject, IsOptional, IsString } from 'class-validator';

export class TranslateDto {
  @IsObject()
  texts!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  targetLang?: string;
}

export class ImportTextDto {
  @IsString()
  text!: string;
}

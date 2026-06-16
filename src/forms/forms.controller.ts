import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { FormsService } from './forms.service';

@Controller('forms')
@UseGuards(AuthGuard)
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  list() {
    return this.forms.listSchemas();
  }

  @Get('resolve')
  resolve(@Query() query: { brokerId?: string; factoryId?: string; brokerSlug?: string; factorySlug?: string; company?: string }) {
    return this.forms.resolve(query);
  }

  @Get(':formType/schema')
  schema(@Param('formType') formType: string) {
    return this.forms.getSchema(formType);
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FACTORY_OWN_FORMS, FORM_SCHEMAS, FORM_TYPES, FormSchema, FormType, SELF_FORM_BROKERS } from './forms.registry';

@Injectable()
export class FormsService {
  constructor(private readonly prisma: PrismaService) {}

  listSchemas() {
    return FORM_TYPES.map((type) => FORM_SCHEMAS[type]);
  }

  getSchema(rawType: string): FormSchema {
    const formType = this.normalizeFormType(rawType);
    if (!formType) throw new BadRequestException('Loai form khong hop le');
    return FORM_SCHEMAS[formType];
  }

  async resolve(query: { brokerId?: string; factoryId?: string; brokerSlug?: string; factorySlug?: string; company?: string }) {
    let brokerSlug = query.brokerSlug;
    let factorySlug = query.factorySlug;
    let brokerFormType: string | null = null;

    if (query.brokerId || query.factoryId) {
      const [broker, factory] = await Promise.all([
        query.brokerId ? this.prisma.company.findUnique({ where: { id: query.brokerId } }) : null,
        query.factoryId ? this.prisma.company.findUnique({ where: { id: query.factoryId } }) : null,
      ]);
      brokerSlug = broker?.slug ?? brokerSlug;
      factorySlug = factory?.slug ?? factorySlug;
      brokerFormType = broker?.formType ?? null;
    }

    const formType = this.resolveFormType({ brokerSlug, factorySlug, company: query.company, brokerFormType });
    const schema = FORM_SCHEMAS[formType];
    return {
      formType,
      label: schema.label,
      templateBase: schema.templateBase,
      requiredFields: schema.requiredFields,
    };
  }

  resolveFormType(input: { brokerSlug?: string | null; factorySlug?: string | null; company?: string | null; brokerFormType?: string | null }): FormType {
    const factorySlug = this.normalizeSlug(input.factorySlug);
    const ownByFactory = factorySlug ? FACTORY_OWN_FORMS[factorySlug] : undefined;
    if (ownByFactory) return ownByFactory;

    const brokerSlug = this.normalizeSlug(input.brokerSlug) || this.normalizeSlug(input.brokerFormType) || this.resolveCompanySlug(input.company);
    const brokerType = this.normalizeFormType(brokerSlug);
    if (brokerType && SELF_FORM_BROKERS.has(brokerType)) return brokerType;
    return 'standard';
  }

  normalizeSnapshot(raw: unknown, fallback?: { brokerSlug?: string | null; factorySlug?: string | null; company?: string | null }): { data: Prisma.InputJsonValue; formType: FormType } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('Du lieu form khong hop le');
    }
    const data = { ...(raw as Record<string, unknown>) };
    const explicitType = this.normalizeFormType(data.formType) ?? this.normalizeFormType(data.company);
    const formType = explicitType ?? this.resolveFormType(fallback ?? {});
    data.formType = formType;
    this.validateFormData(formType, data);
    return { data: data as Prisma.InputJsonValue, formType };
  }

  validateFormData(formType: FormType, data: Record<string, unknown>, opts: { partial?: boolean } = {}) {
    if (opts.partial) return;
    const missing = FORM_SCHEMAS[formType].requiredFields.filter((key) => !this.hasValue(data[key]));
    if (missing.length) throw new BadRequestException(`Thieu thong tin bat buoc: ${missing.join(', ')}`);
  }

  getTemplateFile(formType: FormType, language?: string) {
    const schema = FORM_SCHEMAS[formType];
    const suffix = language === 'zh' ? '_zh' : '';
    return `${schema.templateBase}${suffix}.docx`;
  }

  normalizeFormType(value: unknown): FormType | null {
    if (typeof value !== 'string') return null;
    const slug = this.normalizeSlug(value);
    return FORM_TYPES.find((type) => type === slug) ?? null;
  }

  private resolveCompanySlug(value?: string | null): FormType | null {
    const normalized = this.normalizeSlug(value);
    switch (normalized) {
      case 'thanh-dai':
        return 'thanh-dai';
      case 'truong-thanh':
        return 'truong-thanh';
      case 'vinh-thang':
        return 'vinh-thang';
      case 'ung-minh':
        return 'ung-minh';
      case 'van-thong':
        return 'van-thong';
      case 'hoan-vu':
        return 'hoan-vu';
      default:
        return null;
    }
  }

  private normalizeSlug(value?: string | null) {
    return (value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private hasValue(value: unknown) {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return value !== null && value !== undefined;
  }
}

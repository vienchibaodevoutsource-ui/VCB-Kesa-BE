import { Injectable } from '@nestjs/common';
import { RegistrationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RegistrationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(body: Record<string, unknown>) {
    return this.prisma.registration.create({
      data: {
        status: 'PENDING',
        formType: this.stringValue(body.formType),
        fullName: this.stringValue(body.fullName) || this.stringValue(body.vietnameseName) || 'Unknown',
        phone: this.stringValue(body.phone),
        birthYear: this.stringValue(body.birthYear),
        hometown: this.stringValue(body.hometown),
        gender: this.stringValue(body.gender),
        height: this.stringValue(body.height),
        weight: this.stringValue(body.weight),
        note: this.stringValue(body.note),
        payloadJson: JSON.stringify(body),
      },
    });
  }

  async list(status?: string) {
    const where = status && status in RegistrationStatus ? { status: status as RegistrationStatus } : {};
    return { data: await this.prisma.registration.findMany({ where, orderBy: { createdAt: 'desc' } }) };
  }

  async updateStatus(id: string, status: RegistrationStatus) {
    return this.prisma.registration.update({ where: { id }, data: { status } });
  }

  async remove(id: string) {
    await this.prisma.registration.delete({ where: { id } });
    return { success: true };
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}

import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
// /models của DeepSeek nay chỉ liệt kê deepseek-flash và deepseek-v4-pro ('deepseek-chat'
// vẫn gọi được nhưng không còn được liệt kê). Đọc từ env để đổi model mà không phải deploy lại.
const DEFAULT_MODEL = 'deepseek-flash';
// Không có timeout thì một lần DeepSeek treo (đã gặp: chỉ gửi ': keep-alive' hàng phút
// mà không sinh token) sẽ giữ request sống vô hạn, người dùng chỉ thấy HTTP 500 trống không.
const DEFAULT_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const PROMPT_VERSION = 'v3-aggressive';
const VI_DIACRITICS = /[ăâêôơưđàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;

type CacheEntry = { value: Record<string, unknown>; expiresAt: number };

@Injectable()
export class AiService {
  private readonly translationCache = new Map<string, CacheEntry>();

  constructor(private readonly config: ConfigService) {}

  async translate(texts: Record<string, unknown>, targetLang: string) {
    if (!texts || typeof texts !== 'object') throw new BadRequestException('Invalid payload');
    const apiKey = this.config.get<string>('DEEPSEEK_API_KEY');
    if (!apiKey) throw new InternalServerErrorException('DeepSeek API key not configured');

    const entries = Object.entries(texts).filter(([, value]) => {
      if (typeof value === 'string') return value.trim().length > 0;
      if (Array.isArray(value)) {
        return value.some(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            Object.values(item).some((val) => typeof val === 'string' && val.trim().length > 0),
        );
      }
      return false;
    });

    if (!entries.length) return { data: { translated: texts } };
    const inputPayload = Object.fromEntries(entries);
    const key = this.cacheKey(inputPayload, targetLang);
    const cached = this.getCached(key);
    if (cached) return { data: { translated: { ...texts, ...cached } } };

    const response = await this.callDeepSeek(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: this.config.get<string>('DEEPSEEK_MODEL') || DEFAULT_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Ban la may dich Viet -> Tieng Trung Phon the (zh-TW). Dich moi gia tri string trong JSON sang zh-TW, giu nguyen key, chi tra ve JSON thuan khong markdown. Giu nguyen chu so, ngay thang, kg, cm.',
          },
          { role: 'user', content: `Dich sang zh-TW:\n${JSON.stringify(inputPayload)}` },
        ],
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      throw new BadGatewayException({ error: 'DeepSeek API error', details: await response.text() });
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || '{}';
    let translated: Record<string, unknown>;
    try {
      translated = JSON.parse(content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    } catch {
      throw new InternalServerErrorException({ error: 'Failed to parse translation', details: content });
    }

    if (!Object.values(translated).some((value) => typeof value === 'string' && this.containsVietnamese(value))) {
      this.setCached(key, translated);
    }
    return { data: { translated: { ...texts, ...translated } } };
  }

  /**
   * fetch kèm hạn chờ. DeepSeek có lúc nhận request rồi chỉ gửi `: keep-alive`
   * mà không sinh token nào — không chặn thì request treo vô hạn.
   * Quá hạn → 503 kèm thông báo đọc được, để FE giữ nguyên tiếng Việt và báo
   * người dùng thử lại, thay vì hiện HTTP 500 trống không.
   */
  private async callDeepSeek(url: string, init: RequestInit) {
    const timeoutMs = Number(this.config.get<string>('DEEPSEEK_TIMEOUT_MS')) || DEFAULT_TIMEOUT_MS;
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      if (isTimeout) {
        throw new ServiceUnavailableException({
          error: `Dich vu dich dang ban, khong phan hoi trong ${Math.max(1, Math.round(timeoutMs / 1000))}s. Vui long thu lai sau.`,
          code: 'TRANSLATION_TIMEOUT',
        });
      }
      throw new BadGatewayException({
        error: 'Khong ket noi duoc toi dich vu dich',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getDeepSeekBalance() {
    const apiKey = this.config.get<string>('DEEPSEEK_API_KEY');
    if (!apiKey) throw new InternalServerErrorException('DEEPSEEK_API_KEY chua duoc cau hinh');
    const response = await this.callDeepSeek(DEEPSEEK_BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new BadGatewayException({ error: `DeepSeek API loi: ${response.status}`, details: await response.text() });
    return { data: await response.json() };
  }

  parseRawText(text: string) {
    if (!text || typeof text !== 'string') throw new BadRequestException('Noi dung van ban trong hoac khong hop le');
    const normalized = text.replace(/\s+/g, ' ');
    const result = {
      fullName: '',
      phone: '',
      birthYear: '',
      hometown: '',
      height: '',
      weight: '',
      hasTattoo: null as boolean | null,
      chineseLevel: 'Chua biet',
      experience: '',
      industry: 'Chua chon',
    };

    const phoneMatch = normalized.match(/(?:(?:\+84|84|0)[1-9][0-9]{8})\b|(?:(?:\+84|84|0)[1-9][0-9]{2}[-\s][0-9]{3}[-\s][0-9]{3,4})\b/);
    if (phoneMatch) {
      result.phone = phoneMatch[0].replace(/[-\s]/g, '');
      if (result.phone.startsWith('84')) result.phone = `0${result.phone.slice(2)}`;
      if (result.phone.startsWith('+84')) result.phone = `0${result.phone.slice(3)}`;
    }

    const yearMatch = normalized.match(/\b(19[7-9][0-9]|200[0-9]|2010)\b/);
    if (yearMatch) result.birthYear = yearMatch[1];
    const heightMatch = normalized.match(/(?:cao|chieu cao)\s*(\d{3})\s*(?:cm)?\b/i) || normalized.match(/\b(16[0-9]|17[0-9]|18[0-9]|19[0-9])\b/);
    if (heightMatch) result.height = heightMatch[1];
    const weightMatch = normalized.match(/(?:nang|can nang)?\s*(\d{2})\s*kg\b/i);
    if (weightMatch) result.weight = weightMatch[1];
    if (/(chua|khong|ko|sach)\s*(xam|hinh xam)/i.test(normalized)) result.hasTattoo = false;
    else if (/(co|xam|hinh xam|da xam)/i.test(normalized)) result.hasTattoo = true;

    const nameLabelMatch = text.match(/(?:ho va ten|ho ten|ten em la|ten la|ten)\s*[:\-\s]*([A-ZÀ-Ỹ][a-zà-ỹ]*(?:\s+[A-ZÀ-Ỹ][a-zà-ỹ]*){1,3})/i);
    if (nameLabelMatch?.[1]) result.fullName = nameLabelMatch[1].trim();
    else {
      const nameLine = text
        .split('\n')
        .map((line) => line.trim())
        .find((line) => {
          const words = line.split(/\s+/);
          return words.length >= 2 && words.length <= 4 && words.every((word) => /^[A-ZÀ-Ỹ]/.test(word));
        });
      if (nameLine) result.fullName = nameLine;
    }

    const expLines = text.split('\n').filter((line) => /(kinh nghiem|tung lam|da lam|cong ty|nha may)/i.test(line));
    result.experience = expLines.length ? expLines.join('; ').slice(0, 150) : 'Chua cap nhat kinh nghiem chi tiet';
    return result;
  }

  private cacheKey(texts: Record<string, unknown>, targetLang: string) {
    return createHash('sha256').update(JSON.stringify({ texts, targetLang, v: PROMPT_VERSION })).digest('hex');
  }

  private getCached(key: string) {
    const hit = this.translationCache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.translationCache.delete(key);
      return null;
    }
    return hit.value;
  }

  private setCached(key: string, value: Record<string, unknown>) {
    this.translationCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private containsVietnamese(text: string) {
    return VI_DIACRITICS.test(text);
  }
}

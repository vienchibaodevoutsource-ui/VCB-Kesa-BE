import PizZip from 'pizzip';

/** 12pt — cỡ chữ thống nhất cho toàn bộ nội dung form (half-point). */
export const DEFAULT_FORM_FONT_HALF_PT = 24;

export function normalizeDocxFontSizesXml(xml: string, fontHalfPt = DEFAULT_FORM_FONT_HALF_PT): string {
  const szTag = `<w:sz w:val="${fontHalfPt}"/>`;
  const szCsTag = `<w:szCs w:val="${fontHalfPt}"/>`;

  let next = xml.replace(/<w:sz\b[^>]*\/>/g, szTag);
  next = next.replace(/<w:szCs\b[^>]*\/>/g, szCsTag);
  next = next.replace(/<w:sz\b[^>]*>[\s\S]*?<\/w:sz>/g, szTag);
  next = next.replace(/<w:szCs\b[^>]*>[\s\S]*?<\/w:szCs>/g, szCsTag);

  next = next.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (match, inner: string) => {
    if (inner.includes('<w:sz')) return match;
    return `<w:rPr>${inner}${szTag}${szCsTag}</w:rPr>`;
  });

  return next;
}

export function normalizeDocxFontSizesInZip(zip: PizZip, fontHalfPt = DEFAULT_FORM_FONT_HALF_PT): void {
  for (const relativePath of Object.keys(zip.files)) {
    if (!relativePath.startsWith('word/') || !relativePath.endsWith('.xml')) continue;
    if (relativePath.includes('_rels/')) continue;
    const file = zip.file(relativePath);
    if (!file) continue;
    zip.file(relativePath, normalizeDocxFontSizesXml(file.asText(), fontHalfPt));
  }
}

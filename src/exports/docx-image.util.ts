import PizZip from 'pizzip';

// Nhúng ảnh PNG (base64) vào docx — port từ frontend (thuần thao tác zip/xml, chạy được trên Node).

function nextRelationshipId(xml: string): string {
  const ids = [...xml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  return `rId${Math.max(0, ...ids) + 1}`;
}

function ensurePngContentType(zip: PizZip) {
  const path = '[Content_Types].xml';
  const file = zip.file(path);
  if (!file) return;
  const xml = file.asText();
  if (xml.includes('Extension="png"')) return;
  zip.file(path, xml.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'));
}

function addDocumentImageRelationship(zip: PizZip, target: string): string {
  const path = 'word/_rels/document.xml.rels';
  const file = zip.file(path);
  if (!file) throw new Error('Khong tim thay document relationships trong template Word');
  const xml = file.asText();
  const rId = nextRelationshipId(xml);
  const rel = `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
  zip.file(path, xml.replace('</Relationships>', `${rel}</Relationships>`));
  return rId;
}

function makeImageParagraph(rId: string): string {
  const cx = 31 * 36000;
  const cy = 46.5 * 36000;
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="77881" name="candidate-photo"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="77882" name="candidate-photo.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/** Tìm bảng thứ `index` trong document.xml và thay nội dung qua callback. */
function replaceTableAt(xml: string, index: number, transform: (table: string) => string): string {
  const tables: Array<{ start: number; end: number }> = [];
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    tables.push({ start: m.index, end: m.index + m[0].length });
  }
  const target = tables[index];
  if (!target) return xml;
  const before = xml.slice(0, target.start);
  const table = xml.slice(target.start, target.end);
  const after = xml.slice(target.end);
  return before + transform(table) + after;
}

/** Thay nội dung ô (row, col) — 0-based — trong 1 bảng bằng paragraph mới. */
function replaceTableCell(tableXml: string, row: number, col: number, paragraph: string): string {
  const rows = tableXml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g);
  if (!rows || !rows[row]) return tableXml;
  const targetRow = rows[row];
  const cells = targetRow.match(/<w:tc>[\s\S]*?<\/w:tc>/g);
  if (!cells || !cells[col]) return tableXml;
  const cell = cells[col];
  // Giữ <w:tcPr> (định dạng ô), thay phần paragraph nội dung.
  const tcPrMatch = cell.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/);
  const tcPr = tcPrMatch ? tcPrMatch[0] : '';
  const newCell = `<w:tc>${tcPr}${paragraph}</w:tc>`;
  const newRow = targetRow.replace(cell, newCell);
  return tableXml.replace(targetRow, newRow);
}

export interface PhotoCell {
  table: number;
  row: number;
  col: number;
}

/** Nhúng ảnh base64 (PNG, không kèm tiền tố data:) vào ô chỉ định của document.xml. */
export function embedPhotoIntoDocx(zip: PizZip, base64Png: string, cell: PhotoCell): boolean {
  const clean = base64Png.includes(',') ? base64Png.split(',')[1] : base64Png;
  if (!clean) return false;
  const mediaPath = 'media/candidate-photo.png';
  zip.file(`word/${mediaPath}`, clean, { base64: true });
  ensurePngContentType(zip);
  const rId = addDocumentImageRelationship(zip, mediaPath);
  const file = zip.file('word/document.xml');
  if (!file) return false;
  const xml = replaceTableAt(file.asText(), cell.table, (table) =>
    replaceTableCell(table, cell.row, cell.col, makeImageParagraph(rId)),
  );
  zip.file('word/document.xml', xml);
  return xml.includes('name="candidate-photo"');
}

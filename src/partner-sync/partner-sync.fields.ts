// Các trường 長青 cần mà form kesa không có (hoặc khác định dạng) → người dùng nhập bổ sung trong dialog đẩy hồ sơ.
// Câu hỏi phỏng vấn không nằm ở đây: đọc động theo bộ câu hỏi của dự án (PartnerSheetClient.questionSet).
// target: nơi giá trị được ghép vào payload
//   worker      → worker[key]
//   application → application[key] (dòng Interview_Applications)
export interface ExtraField {
  key: string;
  label: string;
  group: string;
  type: 'text' | 'date' | 'select';
  options?: string[];
  target: 'worker' | 'application';
}

export const EXTRA_FIELDS: ExtraField[] = [
  { key: 'introducer', label: 'Người giới thiệu (介紹人)', group: 'Dự án', type: 'text', target: 'application' },

  { key: 'birthPlace', label: 'Nơi sinh (出生地)', group: 'Cá nhân', type: 'text', target: 'worker' },
  { key: 'diet', label: 'Ăn uống (飲食習慣)', group: 'Cá nhân', type: 'select', options: ['葷', '葷(不吃豬)', '素'], target: 'worker' },
  { key: 'religion', label: 'Tôn giáo (宗教)', group: 'Cá nhân', type: 'select', options: ['佛教', '天主教', '基督教', '伊斯蘭教', '其他'], target: 'worker' },
  { key: 'fatherAlive', label: 'Bố còn sống (父親)', group: 'Cá nhân', type: 'select', options: ['存', '歿'], target: 'worker' },
  { key: 'motherAlive', label: 'Mẹ còn sống (母親)', group: 'Cá nhân', type: 'select', options: ['存', '歿'], target: 'worker' },

  { key: 'visionLeft', label: 'Thị lực trái (視力-左)', group: 'Sức khoẻ', type: 'text', target: 'worker' },
  { key: 'visionRight', label: 'Thị lực phải (視力-右)', group: 'Sức khoẻ', type: 'text', target: 'worker' },

  { key: 'chineseLevel', label: 'Tiếng Trung (中文能力)', group: 'Ngôn ngữ', type: 'select', options: ['完全不會', '略懂', '尚可', '流暢'], target: 'worker' },
  { key: 'englishLevel', label: 'Tiếng Anh (英文能力)', group: 'Ngôn ngữ', type: 'select', options: ['完全不會', '英文字母合格', '簡單會話', '流暢'], target: 'worker' },

  { key: 'passportNo', label: 'Số hộ chiếu (護照號碼)', group: 'Giấy tờ', type: 'text', target: 'worker' },
  { key: 'passportExp', label: 'Hạn hộ chiếu (護照期限)', group: 'Giấy tờ', type: 'date', target: 'worker' },
  { key: 'medExp', label: 'Hạn khám sức khoẻ (體檢期限)', group: 'Giấy tờ', type: 'date', target: 'worker' },
  { key: 'policeExp', label: 'Hạn lý lịch tư pháp (良民證期限)', group: 'Giấy tờ', type: 'date', target: 'worker' },
];

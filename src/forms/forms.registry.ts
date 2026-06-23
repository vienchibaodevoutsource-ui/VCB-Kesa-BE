export const FORM_TYPES = [
  'standard',
  'truong-thanh',
  'vinh-thang',
  'thanh-dai',
  'van-thong',
  'hoan-vu',
  'ung-minh',
] as const;

export type FormType = (typeof FORM_TYPES)[number];

export interface FormSchemaField {
  key: string;
  label: string;
  required?: boolean;
  type?: 'text' | 'number' | 'boolean' | 'array' | 'date';
}

export interface FormSchema {
  formType: FormType;
  label: string;
  templateBase: string;
  requiredFields: string[];
  fields: FormSchemaField[];
}

export const FACTORY_OWN_FORMS: Record<string, FormType> = {
  'vinh-thang': 'vinh-thang',
  'dai-quan': 'van-thong',
};

export const SELF_FORM_BROKERS = new Set<FormType>(['truong-thanh', 'thanh-dai']);

const SHARED_REQUIRED = ['vietnameseName', 'gender', 'phone', 'dateOfBirth'];

const SHARED_REQUIRED_FIELDS: FormSchemaField[] = [
  { key: 'vietnameseName', label: 'Họ tên', required: true },
  { key: 'gender', label: 'Giới tính', required: true },
  { key: 'phone', label: 'Số điện thoại', required: true },
  { key: 'dateOfBirth', label: 'Ngày sinh', required: true, type: 'date' },
  { key: 'cccd', label: 'Căn cước công dân', required: false },
];

export const FORM_SCHEMAS: Record<FormType, FormSchema> = {
  standard: {
    formType: 'standard',
    label: 'Form chung',
    templateBase: 'form_standard_template',
    requiredFields: SHARED_REQUIRED,
    fields: [
      ...SHARED_REQUIRED_FIELDS,
      { key: 'education', label: 'Học lực' },
      { key: 'domesticExperience', label: 'Kinh nghiệm trong nước' },
      { key: 'internationalExperience', label: 'Kinh nghiệm nước ngoài' },
    ],
  },
  'truong-thanh': {
    formType: 'truong-thanh',
    label: 'Trường Thanh',
    templateBase: 'form_truong_thanh_template',
    requiredFields: SHARED_REQUIRED,
    fields: [
      ...SHARED_REQUIRED_FIELDS,
      { key: 'factoryName', label: 'Nhà máy' },
      { key: 'overallComment', label: 'Đánh giá' },
      { key: 'limbImages', label: 'Ảnh tứ chi', type: 'array' },
      { key: 'fullBodyImages', label: 'Ảnh toàn thân', type: 'array' },
    ],
  },
  'vinh-thang': {
    formType: 'vinh-thang',
    label: 'Vĩnh Thắng',
    templateBase: 'form_vinh_thang_template',
    requiredFields: SHARED_REQUIRED,
    fields: [
      ...SHARED_REQUIRED_FIELDS,
      { key: 'mathScore', label: 'Điểm toán' },
      { key: 'beanCount', label: 'Gắp hạt đậu' },
      { key: 'lensCheck', label: 'Kiểm tra kính' },
      { key: 'shiftChoice', label: 'Ca làm việc' },
    ],
  },
  'thanh-dai': {
    formType: 'thanh-dai',
    label: 'Thành Đại',
    templateBase: 'form_thanh_dai_template',
    requiredFields: SHARED_REQUIRED,
    fields: [
      ...SHARED_REQUIRED_FIELDS,
      { key: 'education', label: 'Học lực' },
    ],
  },
  'van-thong': {
    formType: 'van-thong',
    label: 'Vạn Thông',
    templateBase: 'form_van_thong_template',
    requiredFields: SHARED_REQUIRED,
    fields: [
      ...SHARED_REQUIRED_FIELDS,
      { key: 'photoUrl', label: 'Ảnh hồ sơ' },
    ],
  },
  'hoan-vu': {
    formType: 'hoan-vu',
    label: 'Hoàn Vũ',
    templateBase: 'form_hoan_vu_template',
    requiredFields: SHARED_REQUIRED,
    fields: [...SHARED_REQUIRED_FIELDS],
  },
  'ung-minh': {
    formType: 'ung-minh',
    label: 'Ứng Minh',
    templateBase: 'form_ung_minh_template',
    requiredFields: SHARED_REQUIRED,
    fields: [...SHARED_REQUIRED_FIELDS],
  },
};

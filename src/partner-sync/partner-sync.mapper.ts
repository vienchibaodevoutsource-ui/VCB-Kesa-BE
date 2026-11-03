import { Company, FamilyMember, Prisma } from '@prisma/client';
import { normalizeSearch } from '../common/utils/normalize';

export type SyncCandidate = Prisma.CandidateGetPayload<{
  include: { familyMembers: true; broker: true; factory: true; formSnapshot: true };
}>;

// Các cột Candidate gửi nguyên trạng sang đối tác (bỏ cột nội bộ: draftSessionId, nameSearch, formDataJson…).
const RAW_FIELDS = [
  'id', 'candidateCode', 'teamCode', 'status', 'isVerified', 'verifiedByName', 'verifiedAt',
  'vietnameseName', 'chineseName', 'gender', 'dateOfBirth', 'age', 'height', 'weight', 'education',
  'maritalStatus', 'passport', 'criminalRecord', 'healthCheck', 'address', 'religion', 'visionLeft',
  'visionRight', 'handedness', 'smoking', 'drinking', 'colorBlindness', 'tattoos', 'languages',
  'workExperience', 'domesticExperience', 'overseasExperience', 'note', 'cccd', 'phone', 'relativePhone',
  'avatarUrl', 'lineImageUrl', 'limbImages', 'scarImages', 'tattooImages', 'canStandLong',
  'canWorkOvertime', 'canWorkRotation', 'glassesDegree', 'hadSeriousIllness', 'illnessDescription',
  'hadSurgery', 'surgeryDescription', 'hasAstigmatism', 'hasScars', 'scarDescription', 'hasTattoo',
  'isColorBlind', 'isHealthy', 'healthIssueDesc', 'limbsIntact', 'maxLiftKg', 'needsGlasses', 'sweaty',
  'createdAt', 'updatedAt',
] as const;

const GENDER: Record<string, string> = { Nam: '男', 'Nữ': '女', male: '男', female: '女' };
const MARITAL: Record<string, string> = {
  'Chưa kết hôn': '未婚',
  'Đã kết hôn': '已婚',
  'Ly hôn': '離婚',
  'Góa': '喪偶',
};
const RELIGION: Record<string, string> = {
  'Phật': '佛教',
  'Phật giáo': '佛教',
  'Thiên chúa': '天主教',
  'Cơ đốc': '基督教',
  'Hồi giáo': '伊斯蘭教',
  'Khác': '其他',
};
const FATHER = new Set(['Bố', 'Cha', '父親']);
const MOTHER = new Set(['Mẹ', '母親']);

// Payload gửi đối tác gồm 2 phần:
// - raw: dữ liệu gốc của kesa (đầy đủ, để đối tác tự xử lý nếu cần)
// - worker: đã quy đổi sang tên trường + giá trị của form hồ sơ 長青 (englishName, gender=男/女, marital=未婚…)
export function buildPartnerPayload(c: SyncCandidate) {
  const raw: Record<string, unknown> = {};
  for (const key of RAW_FIELDS) raw[key] = c[key];
  raw.broker = companyInfo(c.broker);
  raw.factory = companyInfo(c.factory);
  raw.familyMembers = c.familyMembers.map(({ name, relationship, age, occupation }) => ({ name, relationship, age, occupation }));
  raw.formType = c.formSnapshot?.formType ?? null;
  raw.formData = stripDataUris(c.formSnapshot?.data ?? null);

  const father = findMember(c.familyMembers, FATHER);
  const mother = findMember(c.familyMembers, MOTHER);
  const form = formFields(c.formSnapshot?.data);
  const answers = interviewList(form);
  const worker = {
    externalId: c.id,
    externalCode: c.candidateCode,
    englishName: normalizeSearch(c.vietnameseName).toUpperCase(),
    chineseName: c.chineseName ?? '',
    nativeName: c.vietnameseName,
    nationality: 'VN',
    gender: GENDER[c.gender] ?? c.gender,
    birthDate: toIsoDate(c.dateOfBirth),
    height: c.height ?? '',
    weight: c.weight ?? '',
    religion: RELIGION[c.religion ?? ''] ?? '',
    phone: c.phone ?? '',
    address: c.address ?? '',
    hand: handedness(c.handedness),
    handSweat: yesNo(c.sweaty),
    surgery: c.hadSurgery ? withDetail(c.surgeryDescription) : '無',
    // Form có 2 ô cùng nghĩa (checkbox thói quen + mục thị lực/cơ thể) → có ở ô nào cũng tính là 有.
    colorBlind: anyYes(c.isColorBlind, c.colorBlindness),
    visionLeft: c.visionLeft ?? '',
    visionRight: c.visionRight ?? '',
    tattoo: anyYes(c.hasTattoo, c.tattoos),
    smoke: yesNo(c.smoking),
    drink: yesNo(c.drinking),
    history: healthHistory(c),
    marital: MARITAL[c.maritalStatus ?? ''] ?? '',
    fatherName: father?.name ?? '',
    fatherAge: father?.age ?? '',
    fatherJob: father?.occupation ?? '',
    motherName: mother?.name ?? '',
    motherAge: mother?.age ?? '',
    motherJob: mother?.occupation ?? '',
    rank: siblingRank(form),
    children: children(form, c.maritalStatus),
    taiwanContact: taiwanContact(answers),
    specialty: joinText([text(form.specialSkills), text(form.licenses), ...texts(form.skills)]),
    chineseLevel: speaksMandarin(c, form) ? '略懂' : '完全不會',
    otherLanguage: form.langTaiwanese === true ? '台語 略懂' : '',
    education: education(c.education, text(form.eduMajor)),
    docStatus: docStatus(c),
    headshotUrl: c.avatarUrl ?? '',
    fullbodyUrl: texts(form.fullBodyImages).find((u) => /^https?:\/\//.test(u)) ?? '',
  };

  return { worker, raw };
}

type FormFields = Record<string, unknown>;

const DEGREE: Record<string, string> = {
  'Cấp 1': '國小',
  'Cấp 2': '國中',
  'Cấp 3': '高中',
  'Trung cấp': '高職', // 長青 không có 中專 → gần nhất là 高職
  'Cao đẳng': '大專',
  'Đại học': '大學',
};

// Câu trả lời kesa tự điền được cho câu hỏi 長青, theo questionId (Interview_Questions cột B — cố định dù họ sửa câu chữ).
// Câu hỏi 長青 không có ở đây (vd thêm mới) → người dùng tự trả lời trong dialog đẩy hồ sơ.
// Nguồn: index trong interviewAnswers của form Trường Thanh (21 câu) hoặc cột boolean của Candidate.
const INTERVIEW_FROM_ANSWERS: Record<string, number> = {
  spouseLocation: 0,
  childCaregiver: 1,
  parentCaregiver: 2,
  taiwanRelativeLocation: 4, // Q5 kesa gộp cả "ở đâu, làm gì"
  noOvernightStayAccepted: 7,
  mixedNationalityDormAccepted: 8,
  noCookingDormAccepted: 9,
  leisureActivities: 11, // Q12 kesa gộp cả sở thích
  strengths: 12,
  weaknesses: 13,
  travelWishInTaiwan: 14,
  jobWishInTaiwan: 15,
  previousWorkHardshipDetail: 17,
  earningPurpose: 18,
  returnPlan: 19,
  reaction: 20,
};
const INTERVIEW_YES_NO = new Set(['noOvernightStayAccepted', 'mixedNationalityDormAccepted', 'noCookingDormAccepted']);
const INTERVIEW_ANSWER_COUNT = 21;

const INTERVIEW_FROM_FLAGS: Record<string, keyof SyncCandidate> = {
  limbsCondition: 'limbsIntact',
  healthCondition: 'isHealthy',
  majorHospitalization: 'hadSeriousIllness',
  scarStatus: 'hasScars',
  overtimeAccepted: 'canWorkOvertime',
  shiftAccepted: 'canWorkRotation',
  standingAccepted: 'canStandLong',
  departmentFlexible: 'noPrefForDept',
};

function formFields(value: Prisma.JsonValue | null | undefined): FormFields {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as FormFields) : {};
}

// Snapshot cũ có thể còn bố cục 20/31 câu (FE chỉ migrate khi mở lại form) → lệch index thì bỏ, không đoán.
function interviewList(form: FormFields): string[] {
  const list = texts(form.interviewAnswers, true);
  return list.length === INTERVIEW_ANSWER_COUNT ? list : [];
}

// { questionId: câu trả lời } — chỉ những câu kesa có dữ liệu.
export function autoInterviewAnswers(c: SyncCandidate): Record<string, string> {
  const answers = interviewList(formFields(c.formSnapshot?.data));
  const result: Record<string, string> = {};
  for (const [questionId, index] of Object.entries(INTERVIEW_FROM_ANSWERS)) {
    const answer = answers[index] ?? '';
    const value = INTERVIEW_YES_NO.has(questionId) ? yesNoZh(answer) || answer : answer;
    if (value) result[questionId] = value;
  }
  for (const [questionId, field] of Object.entries(INTERVIEW_FROM_FLAGS)) {
    const value = yesNoZh(c[field]);
    if (value) result[questionId] = value;
  }
  if (c.maxLiftKg != null) result.liftingCapacityKg = String(c.maxLiftKg);
  return result;
}

function healthHistory(c: SyncCandidate) {
  const notes = [c.hadSeriousIllness ? c.illnessDescription : '', c.isHealthy === false ? c.healthIssueDesc : '']
    .map((s) => s?.trim() ?? '')
    .filter(Boolean);
  if (notes.length) return [...new Set(notes)].join('；');
  return c.hadSeriousIllness || c.isHealthy === false ? '有' : '';
}

function siblingRank(form: FormFields) {
  const rank = text(form.siblingRank);
  const total = text(form.siblingsCount);
  return rank && total ? `${rank}/${total}` : rank;
}

function children(form: FormFields, maritalStatus: string | null) {
  const describe = (label: string, kids: unknown) => {
    const ages = Array.isArray(kids) ? kids.map((k) => text((k as FormFields | null)?.age)) : [];
    if (!ages.length) return '';
    const known = ages.filter(Boolean);
    return `${label}${ages.length}人${known.length ? `（${known.join('、')}歲）` : ''}`;
  };
  const parts = [describe('兒子', form.sons), describe('女兒', form.daughters)].filter(Boolean);
  if (parts.length) return parts.join('，');
  return maritalStatus === 'Chưa kết hôn' || text(form.childrenCount) === '0' ? '無' : '';
}

function taiwanContact(answers: string[]) {
  const has = yesNo(answers[3]);
  return has === '有' ? withDetail(answers[4] ?? null) : has;
}

function speaksMandarin(c: SyncCandidate, form: FormFields) {
  // languages 'Hoa' gộp cả tiếng Đài → ưu tiên cờ riêng trong form nếu có.
  return typeof form.langMandarin === 'boolean' ? form.langMandarin : c.languages.includes('Hoa');
}

function education(level: string | null, major: string) {
  const degree = DEGREE[level?.trim() ?? ''];
  return degree ? [{ degree, start: '', end: '', major, majorZh: '', status: '畢' }] : [];
}

// Bỏ key khi không rõ trạng thái (長青: thiếu key = "chưa xác nhận").
function docStatus(c: SyncCandidate) {
  const status = { passport: docState(c.passport), police: docState(c.criminalRecord), medical: docState(c.healthCheck) };
  return Object.fromEntries(Object.entries(status).filter(([, v]) => v));
}

// Form lưu: 'Có' | '護照辦理中 …' | 'Không' (hộ chiếu, lý lịch) và 'Đạt …' | 'Chưa' (khám sức khoẻ).
function docState(value: string | null) {
  const s = value?.trim() ?? '';
  if (s.includes('辦理中')) return '辦理中';
  if (/^(Có|Đạt)/.test(s)) return '有';
  if (/^(Không|Chưa)/.test(s)) return '無';
  return '';
}

function text(value: unknown) {
  if (typeof value === 'string') return value.trim();
  return typeof value === 'number' ? String(value) : '';
}

function texts(value: unknown, keepEmpty = false) {
  const list = Array.isArray(value) ? value.map(text) : [];
  return keepEmpty ? list : list.filter(Boolean);
}

function joinText(parts: string[]) {
  return parts.filter(Boolean).join('；');
}

function companyInfo(company: Company | null) {
  return company ? { id: company.id, slug: company.slug, name: company.name, chineseName: company.chineseName } : null;
}

function findMember(members: FamilyMember[], relationships: Set<string>) {
  return members.find((m) => relationships.has(m.relationship.trim()));
}

// Form kesa lưu ngày sinh dạng dd/mm/yyyy hoặc yyyy-mm-dd; form 長青 dùng <input type="date"> (yyyy-mm-dd).
export function toIsoDate(value: string | null) {
  const s = value?.trim() ?? '';
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

function handedness(value: string | null) {
  const s = (value ?? '').toLowerCase();
  if (s.includes('trái') || s.includes('左')) return '左手';
  if (s.includes('phải') || s.includes('右')) return '右手';
  return '';
}

function yesNo(value: unknown) {
  if (value === true || value === 'Có' || value === 'có' || value === '有') return '有';
  if (value === false || value === 'Không' || value === 'không' || value === '無') return '無';
  return '';
}

function anyYes(...values: unknown[]) {
  const answers = values.map(yesNo);
  if (answers.includes('有')) return '有';
  return answers.includes('無') ? '無' : '';
}

// Câu hỏi phỏng vấn 長青 dùng 是/否 (khác trường hồ sơ dùng 有/無).
function yesNoZh(value: unknown) {
  if (value === 'Có thể') return '是';
  const answer = yesNo(value);
  return answer === '有' ? '是' : answer === '無' ? '否' : '';
}

// 長青 dùng dấu phẩy toàn độ rộng: 有，<chi tiết>
function withDetail(detail: string | null) {
  return detail?.trim() ? `有，${detail.trim()}` : '有';
}

// Snapshot đôi khi còn sót ảnh base64 (khi upload Cloudinary lỗi) → bỏ đi cho payload nhẹ.
function stripDataUris(value: Prisma.JsonValue | null): Prisma.JsonValue | null {
  if (typeof value === 'string') return value.startsWith('data:') ? null : value;
  if (Array.isArray(value)) return value.map(stripDataUris);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripDataUris(v ?? null)]));
  }
  return value;
}

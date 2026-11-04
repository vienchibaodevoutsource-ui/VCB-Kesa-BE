// Server giả lập doPost của 長青 để thử nút "Đẩy sang 長青" ở local khi họ chưa có /exec.
// Chạy:  PARTNER_SYNC_SECRET=<giống .env> node scripts/mock-partner-receiver.mjs
// Rồi đặt PARTNER_SYNC_URL=http://localhost:4100 trong .env của BE và khởi động lại BE.
// Không ghi gì vào sheet thật: chỉ kiểm chữ ký, in tóm tắt payload, trả workerId giả.
// API tra cứu (list_projects, list_questions, export_workers) trả 1 dự án, 4 câu hỏi giả và các worker giả đã đẩy.
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT) || 4100;
const secret = process.env.PARTNER_SYNC_SECRET;
if (!secret) {
  console.error('Thiếu PARTNER_SYNC_SECRET');
  process.exit(1);
}

const workerIds = new Map(); // externalId → workerId giả (đẩy lại thì giữ nguyên)
const workers = new Map(); // workerId → { workerId, englishName, birthDate, phone } cho export_workers

createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const reply = (obj) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    try {
      const parsed = JSON.parse(body);
      if (parsed.action === 'list_projects') {
        return reply({ success: true, projects: [{ code: 'MOCK_TEST', name: 'Dự án giả', label: 'MOCK_TEST Dự án giả', status: '啟用' }] });
      }
      if (parsed.action === 'list_questions') {
        return reply({
          success: true,
          projectCode: parsed.projectCode,
          setId: 'default',
          setName: 'Bộ câu hỏi giả',
          questions: [
            { questionId: 'spouseLocation', sortOrder: 1, section: '家庭', type: 'text', labelZh: '配偶在哪裡', labels: { vn: 'Vợ/chồng ở đâu' }, options: [], updatedAt: '' },
            { questionId: 'overtimeAccepted', sortOrder: 2, section: '工作', type: 'yesno', labelZh: '可以加班嗎', labels: { vn: 'Làm thêm giờ được không' }, options: [], updatedAt: '' },
            { questionId: 'shiftPreference', sortOrder: 3, section: '工作', type: 'select', labelZh: '班別', labels: { vn: 'Ca làm' }, options: ['日班', '夜班', '皆可'], updatedAt: '' },
            { questionId: 'selfIntro', sortOrder: 4, section: '其他', type: 'textarea', labelZh: '自我介紹', labels: { vn: 'Giới thiệu bản thân' }, options: [], updatedAt: '' },
          ],
        });
      }
      if (parsed.action === 'export_workers') {
        return reply({ success: true, workers: [...workers.values()] });
      }
      const { payload, signature } = parsed;
      const expected = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
      if (expected !== signature) return reply({ success: false, error: 'invalid signature' });

      const msg = JSON.parse(payload);
      const { worker, application } = msg;
      const workerId =
        worker.workerId || workerIds.get(worker.externalId) || `VN-KESA-MOCK${workerIds.size + 1}`;
      workerIds.set(worker.externalId, workerId);
      workers.set(workerId, { workerId, englishName: worker.englishName, birthDate: worker.birthDate, phone: worker.phone });

      console.log(`\n[${new Date().toLocaleTimeString()}] Nhận hồ sơ ${worker.externalCode ?? worker.externalId}`);
      console.log('  workerId     :', workerId, worker.workerId ? '(gắn hồ sơ có sẵn)' : '');
      console.log('  dự án        :', application?.projectCode, '| giới thiệu:', application?.introducer || '—');
      console.log('  tên / ngày sinh:', worker.englishName, '/', worker.birthDate);
      console.log('  bổ sung      :', ['birthPlace', 'diet', 'religion', 'englishLevel', 'passportNo', 'passportExp'].map((k) => `${k}=${worker[k] ?? ''}`).join(', '));
      console.log('  phỏng vấn    :', Object.keys(worker.interview ?? {}).length, 'câu có trả lời');
      console.log('  kinh nghiệm  :', (worker.experience ?? []).length, 'dòng |', 'có *Zh:', Object.keys(worker).filter((k) => k.endsWith('Zh') && worker[k]).join(', ') || '—');
      return reply({ success: true, workerId });
    } catch (err) {
      return reply({ success: false, error: String(err?.message || err) });
    }
  });
}).listen(PORT, () => console.log(`Mock 長青 doPost chạy tại http://localhost:${PORT}`));

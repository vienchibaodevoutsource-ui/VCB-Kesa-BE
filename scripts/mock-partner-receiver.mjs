// Server giả lập doPost của 長青 để thử nút "Đẩy sang 長青" ở local khi họ chưa có /exec.
// Chạy:  PARTNER_SYNC_SECRET=<giống .env> node scripts/mock-partner-receiver.mjs
// Rồi đặt PARTNER_SYNC_URL=http://localhost:4100 trong .env của BE và khởi động lại BE.
// Không ghi gì vào sheet thật: chỉ kiểm chữ ký, in tóm tắt payload, trả workerId giả.
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT) || 4100;
const secret = process.env.PARTNER_SYNC_SECRET;
if (!secret) {
  console.error('Thiếu PARTNER_SYNC_SECRET');
  process.exit(1);
}

const workerIds = new Map(); // externalId → workerId giả (đẩy lại thì giữ nguyên)

createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const reply = (obj) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    try {
      const { payload, signature } = JSON.parse(body);
      const expected = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
      if (expected !== signature) return reply({ success: false, error: 'invalid signature' });

      const msg = JSON.parse(payload);
      const { worker, application, answers } = msg;
      const workerId =
        worker.workerId || workerIds.get(worker.externalId) || `VN-KESA-MOCK${workerIds.size + 1}`;
      workerIds.set(worker.externalId, workerId);

      console.log(`\n[${new Date().toLocaleTimeString()}] Nhận hồ sơ ${worker.externalCode ?? worker.externalId}`);
      console.log('  workerId     :', workerId, worker.workerId ? '(gắn hồ sơ có sẵn)' : '');
      console.log('  dự án        :', application?.projectCode, '| giới thiệu:', application?.introducer || '—');
      console.log('  tên / ngày sinh:', worker.englishName, '/', worker.birthDate);
      console.log('  bổ sung      :', ['birthPlace', 'diet', 'religion', 'englishLevel', 'passportNo', 'passportExp'].map((k) => `${k}=${worker[k] ?? ''}`).join(', '));
      console.log('  câu hỏi      :', msg.questionSetId, '|', Object.keys(answers ?? {}).length, 'câu có trả lời');
      return reply({ success: true, workerId });
    } catch (err) {
      return reply({ success: false, error: String(err?.message || err) });
    }
  });
}).listen(PORT, () => console.log(`Mock 長青 doPost chạy tại http://localhost:${PORT}`));

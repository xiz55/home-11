// يستبدل node:sqlite بمحول sql.js (المستخدم في نسخة الآيفون) لتشغيل اختبارات البرنامج كلها على المحرك نفسه.
import initSqlJs from 'sql.js';
import fs from 'node:fs';
import { configureSqlite, DatabaseSync } from '../../src/mobile/sqlite-shim';

const SQL = await initSqlJs();
configureSqlite({
  SQL,
  io: {
    read: (f) => (fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null),
    write: (f, b) => {
      fs.writeFileSync(f + '.tmp', b);
      fs.renameSync(f + '.tmp', f);
    },
  },
});
export { DatabaseSync };

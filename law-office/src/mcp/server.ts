// خادم MCP محلي (نقل stdio فقط — لا منافذ شبكة) لقراءة بيانات يختارها صاحب المكتب.
// يُشغَّل يدويًا من أداة الذكاء الاصطناعي بعد تفعيل التكامل وإصدار رمز:
//   ELECTRON_RUN_AS_NODE=1 LAWOFFICE_DATA_DIR=<مجلد البيانات> LAWOFFICE_MCP_TOKEN=<الرمز> "<LawOfficeManager.exe>" "<...>/dist/mcp/server.js"
// قاعدة المكتب تُفتح للقراءة فقط؛ والسجل يُكتب في قاعدة مستقلة integration/access-log.sqlite.
import path from 'node:path';
import fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Db } from '../main/db/db';
import { openAccessLog } from '../main/integration/accessLog';
import { buildMcpServer } from './tools';


function fail(msg: string): never {
  process.stderr.write(`[law-office-mcp] ${msg}\n`);
  process.exit(1);
}

const dataDir = process.env.LAWOFFICE_DATA_DIR;
const token = process.env.LAWOFFICE_MCP_TOKEN;
if (!dataDir) fail('LAWOFFICE_DATA_DIR غير محدد');
const dbFile = path.join(dataDir, 'office.sqlite');
if (!fs.existsSync(dbFile)) fail('قاعدة البيانات غير موجودة في المجلد المحدد');

let db: Db | null = null;
function getDb(): Db {
  if (!db) db = new Db(dbFile, { readOnly: true });
  return db;
}
const log = openAccessLog(path.join(dataDir, 'integration', 'access-log.sqlite'));

const server = buildMcpServer(getDb, token, log);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[law-office-mcp] جاهز (قراءة فقط، stdio)\n');
}

main().catch((e) => fail((e as Error).message));

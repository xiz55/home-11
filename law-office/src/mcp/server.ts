// خادم MCP محلي (نقل stdio فقط — لا منافذ شبكة) لقراءة بيانات يختارها صاحب المكتب.
// يُشغَّل يدويًا من أداة الذكاء الاصطناعي بعد تفعيل التكامل وإصدار رمز:
//   ELECTRON_RUN_AS_NODE=1 LAWOFFICE_DATA_DIR=<مجلد البيانات> LAWOFFICE_MCP_TOKEN=<الرمز> "<LawOfficeManager.exe>" "<...>/dist/mcp/server.js"
// قاعدة المكتب تُفتح للقراءة فقط؛ والسجل يُكتب في قاعدة مستقلة integration/access-log.sqlite.
import path from 'node:path';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Db } from '../main/db/db';
import { openAccessLog, writeAccess } from '../main/integration/accessLog';
import {
  AccessDenied,
  caseDocuments,
  caseSchedule,
  caseSummary,
  documentText,
  findCases,
  findClients,
  listClientCases,
  resolveToken,
  upcoming,
} from '../main/integration/readApi';

const VERSION = '1.0.0';

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

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function run<T>(tool: string, args: unknown, fn: (scope: ReturnType<typeof resolveToken>['scope']) => T) {
  let tok: ReturnType<typeof resolveToken> | null = null;
  try {
    // التحقق من التفعيل والرمز والنطاق في كل استدعاء (الإلغاء يسري فورًا)
    tok = resolveToken(getDb(), token, new Date());
    const result = fn(tok.scope);
    const count = Array.isArray(result) ? result.length : (result as { matches?: unknown[] })?.matches?.length ?? 1;
    writeAccess(log, { tokenId: tok.id, tokenName: tok.name, tool, args, allowed: true, resultCount: count });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const denied = e instanceof AccessDenied;
    writeAccess(log, { tokenId: tok?.id ?? null, tokenName: tok?.name ?? null, tool, args, allowed: false, error: (e as Error).message });
    return { isError: true, content: [{ type: 'text' as const, text: denied ? `مرفوض: ${(e as Error).message}` : 'تعذر تنفيذ الطلب.' }] };
  }
}

const server = new McpServer(
  { name: 'law-office', version: VERSION },
  {
    instructions:
      'قراءة فقط لبيانات مكتب محاماة سجّلها المستخدم يدويًا. عند تطابق الاسم مع عدة قضايا لا تختر واحدة؛ اطلب التحديد. غياب واقعة في البيانات لا يعني عدم حدوثها. اذكر المرجع (ref) وتاريخ آخر تحديث في إجاباتك. لا تختلق أرقامًا أو مواعيد.',
  },
);

server.registerTool(
  'find_clients',
  { title: 'البحث عن عميل', description: 'يبحث عن العملاء ضمن النطاق المسموح بالاسم (يدعم العربية).', inputSchema: { query: z.string().max(200) }, annotations: READ_ONLY },
  async ({ query }) => run('find_clients', { query }, (scope) => findClients(getDb(), scope, query)),
);

server.registerTool(
  'list_client_cases',
  { title: 'قضايا عميل', description: 'يعرض قضايا عميل محدد ضمن النطاق المسموح مع المرحلة والحالة والموعد التالي.', inputSchema: { client_id: z.string().uuid() }, annotations: READ_ONLY },
  async ({ client_id }) => run('list_client_cases', { client_id }, (scope) => listClientCases(getDb(), scope, client_id, new Date())),
);

server.registerTool(
  'find_cases',
  {
    title: 'البحث عن قضية',
    description: 'يبحث في القضايا المسموحة باسم العميل أو عنوان القضية أو رقم الملف أو الرقم الرسمي أو اسم الخصم. يعيد كل المطابقات دون اختيار عشوائي.',
    inputSchema: { query: z.string().max(200) },
    annotations: READ_ONLY,
  },
  async ({ query }) => run('find_cases', { query }, (scope) => findCases(getDb(), scope, query, new Date())),
);

server.registerTool(
  'get_case_summary',
  {
    title: 'ملخص قضية',
    description: 'ملخص منظم لقضية مسموحة: رقم الملف، العميل، المرحلة، آخر الإجراءات المسجلة، حالة المذكرات، الجلسة القادمة، المهام، المراجع وتاريخ آخر تحديث.',
    inputSchema: { case_id: z.string().uuid() },
    annotations: READ_ONLY,
  },
  async ({ case_id }) => run('get_case_summary', { case_id }, (scope) => caseSummary(getDb(), scope, case_id, new Date())),
);

server.registerTool(
  'list_case_schedule',
  { title: 'جلسات ومهام قضية', description: 'الجلسات والمهام والمواعيد الإجرائية المسجلة لقضية مسموحة.', inputSchema: { case_id: z.string().uuid() }, annotations: READ_ONLY },
  async ({ case_id }) => run('list_case_schedule', { case_id }, (scope) => caseSchedule(getDb(), scope, case_id, new Date())),
);

server.registerTool(
  'list_upcoming',
  { title: 'المواعيد القادمة', description: 'الجلسات المجدولة القادمة في القضايا المسموحة خلال عدد أيام.', inputSchema: { days: z.number().int().min(1).max(120).default(14) }, annotations: READ_ONLY },
  async ({ days }) => run('list_upcoming', { days }, (scope) => upcoming(getDb(), scope, days ?? 14, new Date())),
);

server.registerTool(
  'list_case_documents',
  { title: 'مستندات قضية', description: 'قائمة بيانات المستندات (دون المحتوى) لقضية مسموحة.', inputSchema: { case_id: z.string().uuid() }, annotations: READ_ONLY },
  async ({ case_id }) => run('list_case_documents', { case_id }, (scope) => caseDocuments(getDb(), scope, case_id)),
);

server.registerTool(
  'read_document_text',
  {
    title: 'قراءة نص مستند',
    description: 'يقرأ نص مذكرة مكتوبة في البرنامج أو النص المستخرج محليًا من مستند مسموح، إذا سمح صاحب المكتب بذلك لهذا الربط.',
    inputSchema: { document_id: z.string().uuid().describe('معرّف المستند أو المذكرة') },
    annotations: READ_ONLY,
  },
  async ({ document_id }) => run('read_document_text', { document_id }, (scope) => documentText(getDb(), scope, document_id)),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[law-office-mcp] جاهز (قراءة فقط، stdio)\n');
}

main().catch((e) => fail((e as Error).message));

// وحدة التكامل: غير المفعلة لا تتيح بيانات، والمفعلة تحترم نطاق القراءة ولا تسمح بالكتابة.
// يشغل خادم MCP الفعلي (dist/mcp/server.js) عبر stdio بعميل MCP الرسمي.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { call, makeCore, makeDocx, seedCompany, setupOwner, stageAndAttach } from './helpers';

const serverJs = path.resolve('dist/mcp/server.js');

async function connect(dataDir: string, token: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-warnings', serverJs],
    env: { ...process.env, LAWOFFICE_DATA_DIR: dataDir, LAWOFFICE_MCP_TOKEN: token } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function text(r: any): string {
  return r.content?.[0]?.text ?? '';
}

describe('التكامل الاختياري عبر MCP', () => {
  const { core, platform, dir } = makeCore();
  const S = 'S';
  let ids: Awaited<ReturnType<typeof seedCompany>>;
  let ahmadA = '';
  let ahmadB = '';
  let token = '';
  let docId = '';
  let client: Client | null = null;

  beforeAll(async () => {
    if (!fs.existsSync(serverJs)) execFileSync(process.execPath, ['scripts/build.mjs', 'backend'], { stdio: 'inherit' });
    await setupOwner(core, S);
    ids = await seedCompany(core, S);
    const ahmad = (await call(core, S, 'clients.create', { kind: 'individual', name: 'أحمد الخيالي' })).id;
    ahmadA = (await call(core, S, 'cases.create', { clientId: ahmad, title: 'قضية أحمد الأولى', firstStage: { stageType: 'الدرجة الأولى', officialCaseNo: '111' } })).id;
    ahmadB = (await call(core, S, 'cases.create', { clientId: ahmad, title: 'قضية أحمد الثانية' })).id;
    const c = await call(core, S, 'cases.get', { id: ahmadA });
    await call(core, S, 'hearings.create', { caseId: ahmadA, stageId: c.stages[0].id, date: '2026-12-15', time: '10:00' });
    const d = await makeDocx(path.join(dir, 'memo.docx'), ['نص مذكرة سري للاختبار']);
    docId = (await stageAndAttach(core, platform, S, d, { title: 'مذكرة', category: 'memo', clientId: ids.clientId, caseId: ids.laborId })).id;
    await core.extraction.idle();
  });

  afterAll(async () => {
    await client?.close();
  });

  it('رمز صادر والتكامل غير مفعّل ← لا بيانات', async () => {
    const t = await call(core, S, 'integration.createToken', { name: 'اختبار', clientIds: [], caseIds: [ahmadA, ahmadB], allowDocumentText: false });
    token = t.token;
    expect(t.snippets.codexToml).toContain('[mcp_servers.law_office]');
    expect(t.snippets.claudeJson).toContain('LAWOFFICE_MCP_TOKEN');
    const stored = core.db.get<{ token_hash: string }>('SELECT token_hash FROM integration_tokens')!;
    expect(stored.token_hash).not.toContain(token);
    client = await connect(core.paths.dataDir, token);
    const r = await client.callTool({ name: 'find_cases', arguments: { query: 'أحمد' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('غير مفعّل');
  });

  it('لا يمكن التفعيل دون الإقرار بإرسال النص للمزود الخارجي', async () => {
    const r = await core.dispatch(S, 'integration.setEnabled', { enabled: true });
    expect(r.ok).toBe(false);
    await call(core, S, 'integration.setEnabled', { enabled: true, acknowledged: true });
  });

  it('الأدوات قراءة فقط ولا توجد أداة كتابة أو SQL أو ملفات', async () => {
    const tools = await client!.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['find_cases', 'get_case_summary', 'list_case_schedule', 'read_document_text']));
    for (const n of names) expect(n).not.toMatch(/write|create|update|delete|sql|exec|file_path|shell/i);
    for (const t of tools.tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it('«قضية أحمد ماذا حصل فيها؟» — يعيد كل المطابقات ولا يختار عشوائيًا', async () => {
    const r = await client!.callTool({ name: 'find_cases', arguments: { query: 'أحمد' } });
    const data = JSON.parse(text(r));
    expect(data.matches).toHaveLength(2);
    expect(data.note).toContain('أكثر من قضية');
    const sum = JSON.parse(text(await client!.callTool({ name: 'get_case_summary', arguments: { case_id: ahmadA } })));
    expect(sum.internal_file_no).toBeTruthy();
    expect(sum.client).toBe('أحمد الخيالي');
    expect(sum.current_stage.official_case_no).toBe('111');
    expect(sum.upcoming_hearings).toHaveLength(1);
    expect(sum.data_note).toContain('لا يعني');
    expect(sum.last_updated_in_app).toBeTruthy();
  });

  it('النطاق محترم: قضايا الشركة غير ممنوحة لهذا الرمز', async () => {
    const r = await client!.callTool({ name: 'get_case_summary', arguments: { case_id: ids.laborId } });
    expect(r.isError).toBe(true);
    const f = JSON.parse(text(await client!.callTool({ name: 'find_cases', arguments: { query: 'المثال' } })));
    expect(f.matches).toHaveLength(0);
    const c = JSON.parse(text(await client!.callTool({ name: 'find_clients', arguments: { query: '' } })));
    expect(c.map((x: any) => x.name)).toEqual(['أحمد الخيالي']);
  });

  it('قراءة نصوص المستندات تتطلب إذنًا صريحًا ونطاقًا', async () => {
    const t2 = await call(core, S, 'integration.createToken', { name: 'مع النصوص', clientIds: [ids.clientId], caseIds: [], allowDocumentText: true });
    const c2 = await connect(core.paths.dataDir, t2.token);
    const r = JSON.parse(text(await c2.callTool({ name: 'read_document_text', arguments: { document_id: docId } })));
    expect(r.text).toContain('نص مذكرة سري');
    const denied = await client!.callTool({ name: 'read_document_text', arguments: { document_id: docId } });
    expect(denied.isError).toBe(true);
    await c2.close();
  });

  it('قاعدة المكتب لا تتغير بسبب استدعاءات الربط، والوصول مسجل', async () => {
    const before = core.db.get<{ n: number }>('SELECT count(*) AS n FROM activity_log')!.n;
    await client!.callTool({ name: 'list_upcoming', arguments: { days: 30 } });
    expect(core.db.get<{ n: number }>('SELECT count(*) AS n FROM activity_log')!.n).toBe(before);
    const log = await call(core, S, 'integration.accessLog', {});
    expect(log.some((l: any) => l.tool === 'get_case_summary' && l.allowed)).toBe(true);
    expect(log.some((l: any) => !l.allowed)).toBe(true);
  });

  it('إلغاء الرمز وتعطيل التكامل يسريان فورًا', async () => {
    const st = await call(core, S, 'integration.state', {});
    await call(core, S, 'integration.revokeToken', { id: st.tokens.find((t: any) => t.name === 'اختبار').id });
    const r = await client!.callTool({ name: 'find_cases', arguments: { query: 'أحمد' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('إلغاء');
    await call(core, S, 'integration.setEnabled', { enabled: false });
  });
});

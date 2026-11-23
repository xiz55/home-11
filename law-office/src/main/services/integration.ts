// إدارة التكامل الاختياري مع أدوات الذكاء الاصطناعي عبر MCP (stdio محلي). غير مفعّل افتراضيًا.
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context';
import { uuid } from '../context';
import { AppError, notFound } from '../errors';
import { requireOwner } from './access';
import { logActivity } from './activity';
import { readSetting, writeSetting } from './settings';
import { hashToken } from '../integration/readApi';
import { readAccess } from '../integration/accessLog';
import { runtime } from '../runtime';

export function integrationState(ctx: Ctx) {
  requireOwner(ctx);
  const tokens = ctx.db
    .all<{ id: string; name: string; token_hint: string; scope: string; expires_on: string | null; revoked_at: string | null; created_at: string }>(
      'SELECT id, name, token_hint, scope, expires_on, revoked_at, created_at FROM integration_tokens ORDER BY created_at DESC',
    )
    .map((t) => {
      const scope = JSON.parse(t.scope) as { clientIds: string[]; caseIds: string[]; allowDocumentText: boolean };
      return {
        id: t.id,
        name: t.name,
        hint: t.token_hint,
        clientCount: scope.clientIds.length,
        caseCount: scope.caseIds.length,
        clientNames: scope.clientIds.map((id) => ctx.db.get<{ name: string }>('SELECT name FROM clients WHERE id = ?', [id])?.name ?? '(محذوف)'),
        caseLabels: scope.caseIds.map((id) => {
          const c = ctx.db.get<{ file_no: string; title: string }>('SELECT file_no, title FROM cases WHERE id = ?', [id]);
          return c ? `${c.file_no} — ${c.title}` : '(محذوف)';
        }),
        allowDocumentText: scope.allowDocumentText,
        expiresOn: t.expires_on,
        revokedAt: t.revoked_at,
        createdAt: t.created_at,
      };
    });
  return {
    enabled: readSetting(ctx.db, 'integration.enabled'),
    enabledAt: readSetting(ctx.db, 'integration.enabledAt'),
    tokens,
    server: { execPath: runtime.execPath, scriptPath: runtime.mcpScriptPath, dataDir: ctx.paths.dataDir, isPackaged: runtime.isPackaged },
  };
}

export function setIntegrationEnabled(ctx: Ctx, input: { enabled: boolean; acknowledged: boolean }) {
  requireOwner(ctx);
  if (input.enabled && !input.acknowledged)
    throw new AppError('VALIDATION', 'يجب الإقرار بفهم أن النص المسموح قد يُرسل إلى مزود الذكاء الاصطناعي الخارجي عند استخدامه.', { acknowledged: 'مطلوب' });
  const now = ctx.now().toISOString();
  ctx.db.tx(() => {
    writeSetting(ctx.db, 'integration.enabled', input.enabled, now);
    writeSetting(ctx.db, 'integration.enabledAt', input.enabled ? now : null, now);
    logActivity(ctx, { action: 'integration', entityType: 'integration', summary: input.enabled ? 'تفعيل وحدة التكامل (قراءة فقط عبر MCP محلي)' : 'تعطيل وحدة التكامل' });
  });
  return { ok: true };
}

function q(s: string) {
  return JSON.stringify(s);
}

export function configSnippets(dataDir: string, token: string) {
  const exe = runtime.execPath;
  const script = runtime.mcpScriptPath;
  const env = { ELECTRON_RUN_AS_NODE: '1', LAWOFFICE_DATA_DIR: dataDir, LAWOFFICE_MCP_TOKEN: token };
  // Claude Code: خادم stdio لا يحتاج حقل type؛ الخيارات قبل الاسم ثم -- ثم الأمر
  const claudeJson = JSON.stringify({ mcpServers: { 'law-office': { command: exe, args: [script], env } } }, null, 2);
  const claudeCli = `claude mcp add --env ELECTRON_RUN_AS_NODE=1 --env LAWOFFICE_DATA_DIR=${q(dataDir)} --env LAWOFFICE_MCP_TOKEN=${token} --transport stdio --scope user law-office -- ${q(exe)} ${q(script)}`;
  const tomlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const codexToml = `[mcp_servers.law_office]
command = ${tomlStr(exe)}
args = [${tomlStr(script)}]
startup_timeout_sec = 30

[mcp_servers.law_office.env]
ELECTRON_RUN_AS_NODE = "1"
LAWOFFICE_DATA_DIR = ${tomlStr(dataDir)}
LAWOFFICE_MCP_TOKEN = "${token}"`;
  const codexCli = `codex mcp add law_office --env ELECTRON_RUN_AS_NODE=1 --env LAWOFFICE_DATA_DIR=${q(dataDir)} --env LAWOFFICE_MCP_TOKEN=${token} -- ${q(exe)} ${q(script)}`;
  return { claudeJson, claudeCli, codexToml, codexCli };
}

export function createIntegrationToken(ctx: Ctx, input: { name: string; clientIds: string[]; caseIds: string[]; allowDocumentText: boolean; expiresOn: string | null }) {
  requireOwner(ctx);
  if (!input.clientIds.length && !input.caseIds.length) throw new AppError('VALIDATION', 'اختر عميلًا أو قضية واحدة على الأقل', { caseIds: 'حدد نطاق الوصول' });
  for (const id of input.clientIds) if (!ctx.db.get('SELECT id FROM clients WHERE id = ?', [id])) throw new AppError('VALIDATION', 'عميل غير موجود في النطاق');
  for (const id of input.caseIds) if (!ctx.db.get('SELECT id FROM cases WHERE id = ?', [id])) throw new AppError('VALIDATION', 'قضية غير موجودة في النطاق');
  const raw = 'lom_' + randomBytes(32).toString('base64url');
  const id = uuid();
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO integration_tokens (id, name, token_hash, token_hint, scope, expires_on, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      input.name,
      hashToken(raw),
      raw.slice(-4),
      JSON.stringify({ clientIds: [...new Set(input.clientIds)], caseIds: [...new Set(input.caseIds)], allowDocumentText: input.allowDocumentText }),
      input.expiresOn,
      ctx.user!.id,
      ctx.now().toISOString(),
    ]);
    logActivity(ctx, {
      action: 'integration',
      entityType: 'integration_token',
      entityId: id,
      summary: `إصدار رمز ربط «${input.name}»: ${input.clientIds.length} عميل، ${input.caseIds.length} قضية، نصوص المستندات: ${input.allowDocumentText ? 'مسموحة' : 'غير مسموحة'}`,
    });
  });
  return { id, token: raw, snippets: configSnippets(ctx.paths.dataDir, raw) };
}

export function revokeIntegrationToken(ctx: Ctx, input: { id: string }) {
  requireOwner(ctx);
  const t = ctx.db.get<{ name: string; revoked_at: string | null }>('SELECT name, revoked_at FROM integration_tokens WHERE id = ?', [input.id]);
  if (!t) throw notFound('رمز الربط');
  if (t.revoked_at) return { ok: true };
  ctx.db.tx(() => {
    ctx.db.run('UPDATE integration_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ?', [ctx.now().toISOString(), ctx.user!.id, input.id]);
    logActivity(ctx, { action: 'integration', entityType: 'integration_token', entityId: input.id, summary: `إلغاء رمز الربط «${t.name}»` });
  });
  return { ok: true };
}

export function integrationAccessLog(ctx: Ctx) {
  requireOwner(ctx);
  return readAccess(ctx.paths.accessLogDb, 300);
}

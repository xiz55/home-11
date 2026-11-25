// بدائل عامة يجب أن تسبق تحميل أي وحدة أخرى (path-browserify وغيرها تتوقع process وBuffer).
import { Buffer } from 'buffer';

const g = globalThis as unknown as { process?: unknown; Buffer?: unknown; global?: unknown };
g.global ??= globalThis;
g.Buffer ??= Buffer;
g.process ??= {
  env: {},
  platform: 'ios',
  versions: {},
  argv: [],
  cwd: () => '/',
  nextTick: (fn: (...a: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => fn(...a)),
  getuid: () => 501,
  emitWarning: () => undefined,
};

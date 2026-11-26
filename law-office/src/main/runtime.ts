// معلومات بيئة التشغيل تُضبط من العملية الرئيسية (أو من الاختبارات).
export interface RuntimeInfo {
  appVersion: string;
  execPath: string;
  mcpScriptPath: string;
  fontsDir: string;
  docsDir: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  customDataDir: boolean;
}

export const runtime: RuntimeInfo = {
  appVersion: '1.0.0',
  execPath: process.execPath,
  mcpScriptPath: '',
  fontsDir: '',
  docsDir: '',
  isPackaged: false,
  platform: process.platform,
  customDataDir: false,
};

export function setRuntime(r: Partial<RuntimeInfo>) {
  Object.assign(runtime, r);
}

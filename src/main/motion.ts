import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { reportsDir, safeFileName, uniquePath } from './paths';

export function readMotionProjectFile(filePath: string): { project: any; missingMedia: boolean } {
  const raw = fs.readFileSync(filePath, 'utf8');
  const project = JSON.parse(raw);
  if (!project || project.version !== 1 || !project.media || !Array.isArray(project.objects) || !project.calibration) {
    throw new Error('This is not a valid Thrustbook motion-analysis project');
  }
  const paths: string[] = [project.media?.path, ...(Array.isArray(project.media?.paths) ? project.media.paths : [])].filter(
    (value): value is string => typeof value === 'string' && Boolean(value),
  );
  return { project, missingMedia: paths.some((p) => !fs.existsSync(p)) };
}

export async function writeMotionPdf(html: string, title: string): Promise<{ htmlPath: string; pdfPath: string }> {
  const dir = reportsDir();
  const base = safeFileName(title || 'motion-analysis').replace(/\.(html|pdf)$/i, '') || 'motion-analysis';
  const htmlPath = uniquePath(dir, `${base}.html`);
  const pdfPath = uniquePath(dir, `${base}.pdf`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1200,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await win.loadFile(htmlPath);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    fs.writeFileSync(pdfPath, pdf);
  } finally {
    win.destroy();
  }
  return { htmlPath, pdfPath };
}

export function projectFileName(name: string): string {
  const base = safeFileName(name || 'motion-analysis').replace(/\.[^.]+$/, '');
  return `${base}.tbmotion`;
}

export function writeTextFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

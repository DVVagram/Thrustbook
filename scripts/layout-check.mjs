import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const VIEWPORT_WIDTH = 1120;
const PAGES = [
  'dashboard',
  'projects',
  'development',
  'components',
  'sensors',
  'revisions',
  'inventory',
  'finance',
  'ground',
  'flights',
  'experiments',
  'datalog',
  'analysis',
  'compare',
  'documents',
  'issues',
  'reports',
  'templates',
  'settings',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPage(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // The app is still starting.
    }
    await sleep(200);
  }
  throw new Error(`Electron did not expose a page within ${timeoutMs / 1000}s`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;

    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            pending.set(id, { res, rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener('error', () => reject(new Error('Could not connect to the Electron renderer')));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.rej(new Error(message.error.message));
      else waiter.res(message.result);
    });
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'Renderer evaluation failed');
  }
  return result.result.value;
}

async function waitForRoute(cdp, route) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ready = await evaluate(
      cdp,
      `location.hash === '#/${route}' && !!document.querySelector('.page-head h1') && !document.querySelector('.splash')`,
    );
    if (ready) return;
    await sleep(100);
  }
  throw new Error(`Page ${route} did not render`);
}

function stopApp(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

const AUDIT = `(() => {
  const issues = [];
  const tolerance = 2;
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const describe = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '';
    const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    return el.tagName.toLowerCase() + cls + (text ? ' "' + text + '"' : '');
  };

  const controls = [...document.querySelectorAll('button, a, input, select, textarea')].filter(visible);
  for (const control of controls) {
    if (control.tagName === 'BUTTON' || control.tagName === 'A') {
      const text = (control.innerText || '').trim();
      if (!text) continue;
      const rect = control.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(control);
      const textRect = range.getBoundingClientRect();
      if (textRect.width > 0 && (
        textRect.left < rect.left - tolerance ||
        textRect.right > rect.right + tolerance ||
        control.scrollWidth > control.clientWidth + tolerance
      )) {
        issues.push({ kind: 'button text overflow', element: describe(control) });
      }
    }
    const rect = control.getBoundingClientRect();
    if (!control.closest('.sidebar') && (rect.left < -tolerance || rect.right > innerWidth + tolerance)) {
      issues.push({ kind: 'control outside viewport', element: describe(control) });
    }
  }

  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i];
      const b = controls[j];
      if (a.contains(b) || b.contains(a) || a.closest('.sidebar') || b.closest('.sidebar')) continue;
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const overlapX = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
      const overlapY = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
      if (overlapX > tolerance && overlapY > tolerance) {
        issues.push({ kind: 'overlapping controls', elements: [describe(a), describe(b)] });
      }
    }
  }

  return [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()];
})()`;

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'thrustbook-layout-'));
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const examplesDir = path.join(tempRoot, 'examples');
let child;
let cdp;

try {
  const port = await freePort();
  child = spawn(
    electronPath,
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        THRUSTBOOK_WORKSPACE: 'examples',
        THRUSTBOOK_DATA_DIR: dataDir,
        THRUSTBOOK_EXAMPLES_ROOT: examplesDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
  });

  const page = await waitForPage(port);
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT_WIDTH,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `!!document.querySelector('.app-shell') && !document.querySelector('.splash')`)) break;
    await sleep(200);
  }

  const failures = [];
  for (const pageName of PAGES) {
    await evaluate(cdp, `location.hash = '#/${pageName}'`);
    await waitForRoute(cdp, pageName);
    await sleep(400);
    const issues = await evaluate(cdp, AUDIT);
    for (const issue of issues) failures.push({ page: pageName, ...issue });
  }

  if (failures.length) {
    console.error(`Layout check failed at ${VIEWPORT_WIDTH}px:\n`);
    for (const failure of failures) {
      console.error(`  ${failure.page}: ${failure.kind}: ${failure.element ?? failure.elements?.join(' / ')}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Layout check passed: ${PAGES.length} pages at ${VIEWPORT_WIDTH}px, no button text overflow or overlapping controls.`);
  }
} catch (error) {
  console.error(`Layout check could not run: ${error.message}`);
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (child) {
    stopApp(child);
    await sleep(500);
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

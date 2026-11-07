import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { getRepositoryContext, readRepositoryFile } from '../lib/repository.js';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev Assistant</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#101521;color:#e8edf7;font:15px system-ui,sans-serif}
header{padding:22px 5%;background:#171f30;border-bottom:1px solid #303b50}
h1{margin:0;font-size:23px}main{max-width:1100px;margin:35px auto;padding:0 20px}
.panel{background:#171f30;border:1px solid #303b50;border-radius:12px;padding:22px;margin-bottom:20px}
input,button{font:inherit;padding:12px;border-radius:7px}
input{background:#0f1521;color:white;border:1px solid #45516a;width:100%;margin:12px 0}
button{background:#8a9dff;color:#101521;border:0;font-weight:700;cursor:pointer}
.muted{color:#9ba9c2}.layout{display:grid;grid-template-columns:minmax(220px,1fr) 2fr;gap:18px}
#files button{display:block;width:100%;text-align:left;margin:5px 0;background:#242f44;color:#e8edf7;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:65vh;overflow:auto;background:#0d121c;padding:15px;border-radius:8px}
.hidden{display:none}.status{margin-top:12px;color:#b9c6df}
@media(max-width:650px){.layout{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><h1>Dev Assistant</h1><div class="muted">Local development workspace</div></header>
<main>
<section id="chooser" class="panel">
<h2>Select a project</h2>
<p class="muted">Enter the absolute path to a local Git repository on this computer.</p>
<form id="selectForm">
<input id="folder" placeholder="/home/kingche/Program.dev/your-project" required>
<button type="submit">Open project</button>
</form>
<div id="message" class="status"></div>
</section>
<section id="workspace" class="hidden">
<div class="panel"><h2 id="projectTitle">Project</h2><div id="summary" class="muted"></div></div>
<div class="layout">
<div class="panel"><h3>Tracked files</h3><div id="files"></div></div>
<div class="panel"><h3 id="fileTitle">Project overview</h3><pre id="preview">Choose a file to preview it.</pre></div>
</div>
<button id="changeProject">Choose another project</button>
</section>
</main>
<script>
const token='__TOKEN__';
const $=id=>document.getElementById(id);
let selected=false;
async function api(url,data){
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Dev-Assistant-Token':token},body:JSON.stringify(data)});
 const result=await r.json();
 if(!r.ok)throw new Error(result.error||'Request failed');
 return result;
}
$('selectForm').addEventListener('submit',async e=>{
 e.preventDefault();$('message').textContent='Checking repository...';
 try{
  const result=await api('/api/select',{directory:$('folder').value.trim()});
  selected=true;$('chooser').classList.add('hidden');$('workspace').classList.remove('hidden');
  $('projectTitle').textContent=result.root;
  $('summary').textContent='Branch: '+result.branch+' | Git status: '+result.status;
  $('files').replaceChildren();
  for(const file of result.files){
   const b=document.createElement('button');b.textContent=file;
   b.addEventListener('click',()=>openFile(file));$('files').appendChild(b);
  }
  $('fileTitle').textContent='Project overview';
  $('preview').textContent='Choose a tracked file to preview it. Files over the safety limit and sensitive paths are not displayed.';
 }catch(err){$('message').textContent=err.message;}
});
async function openFile(file){
 $('fileTitle').textContent=file;$('preview').textContent='Loading...';
 try{const r=await api('/api/read',{file});$('preview').textContent=r.content;}
 catch(err){$('preview').textContent=err.message;}
}
$('changeProject').addEventListener('click',()=>{
 selected=false;$('workspace').classList.add('hidden');$('chooser').classList.remove('hidden');$('message').textContent='';
});
</script>
</body></html>`;

/** Require same-origin browser requests and the per-process bearer token. */
export function isTrustedGuiRequest(
  headers: IncomingHttpHeaders,
  expectedOrigin: string,
  token: string,
): boolean {
  const suppliedToken = headers['x-dev-assistant-token'];
  if (
    headers.host !== new URL(expectedOrigin).host ||
    headers.origin !== expectedOrigin ||
    typeof suppliedToken !== 'string'
  ) {
    return false;
  }
  const expected = Buffer.from(token);
  const supplied = Buffer.from(suppliedToken);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function launchGui(): Promise<void> {
  const token = randomBytes(32).toString('hex');
  let selectedRoot: string | null = null;

  let expectedOrigin: string | null = null;

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');

    if (!expectedOrigin) {
      res.writeHead(503).end('Server is starting.');
      return;
    }

    const expectedHost = new URL(expectedOrigin).host;
    if (req.headers.host !== expectedHost) {
      res.writeHead(403).end('Request denied.');
      return;
    }

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      });
      res.end(PAGE.replace('__TOKEN__', token));
      return;
    }

    if (!req.url?.startsWith('/api/')) {
      res.writeHead(404).end('Not found');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end('POST required.');
      return;
    }

    if (!isTrustedGuiRequest(req.headers, expectedOrigin, token)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request denied.' }));
      return;
    }

    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Content-Type must be application/json.' }));
      return;
    }

    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 20_000) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request too large.' }));
      return;
    }

    try {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > 20_000) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request too large.' }));
          return;
        }
        chunks.push(buffer);
      }

      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw || '{}') as {
        directory?: string;
        file?: string;
      };

      if (req.url === '/api/select') {
        if (!body.directory || !path.isAbsolute(body.directory)) {
          throw new Error('Enter an absolute local folder path.');
        }
        const context = getRepositoryContext(body.directory);
        if (!context) throw new Error('That folder is not inside a valid Git repository.');
        selectedRoot = context.root;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          root: context.root,
          branch: context.branch,
          status: context.status,
          files: context.files
        }));
        return;
      }

      if (req.url === '/api/read') {
        if (!selectedRoot) throw new Error('Select a project first.');
        if (!body.file) throw new Error('Choose a file first.');
        const content = readRepositoryFile(body.file, selectedRoot);
        if (content === null) throw new Error('File unavailable or blocked by repository safety rules.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown API endpoint.' }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : 'Request failed.'
      }));
    }
  });

  server.on('error', (error) => {
    console.error('Dev Assistant GUI server error:', error.message);
  });

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      console.error('Could not determine GUI server address.');
      server.close();
      return;
    }
    const url = `http://127.0.0.1:${address.port}/`;
    expectedOrigin = new URL(url).origin;
    console.log(`Dev Assistant GUI running at ${url}`);
    if (process.env.DEV_ASSISTANT_TAURI === '1') {
      console.log('Dev Assistant desktop window is connecting to the local GUI.');
      return;
    }
    console.log('Keep this terminal open while using the GUI. Press Ctrl+C to stop.');
    const browser = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    browser.on('error', () => console.log(`Open this address in your browser: ${url}`));
    browser.unref();
  });
}

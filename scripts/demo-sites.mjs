import http from 'node:http';
const style = `<style>body{font:16px system-ui;max-width:750px;margin:60px auto;padding:20px;background:#f4f6f2;color:#30473d}header,section{background:white;padding:24px;border:1px solid #d8e1d8;border-radius:12px;margin-bottom:16px}button,a,input,textarea{font:inherit;margin:8px;padding:9px}a{display:inline-block;color:#176b58}input,textarea{border:1px solid #d8e1d8;border-radius:6px}small{display:block;color:#71816f}</style>`;
function html(port, path) {
  const queue = port === 4401;
  const header = `<header><small>SYNTHETIC DEMO · ordinary HTML, no extension hooks</small><h1>${queue ? 'Request queue' : 'Record workspace'}</h1><nav><a href="/">Open</a><a href="/edit">Edit</a><a href="/search">Search</a></nav></header>`;
  const body = queue
    ? `<section><h2>Sample request #42</h2><p>Fictional information only. Qualify this request in the record workspace, then prepare a reply.</p><a href="http://localhost:4402" target="_blank">Open</a><button>Reply</button><button>Next</button><button>Close</button><button>Back</button><p><input type="password" placeholder="Privacy canary: fictional password"/><textarea placeholder="Private canary: not observed"></textarea></p></section>`
    : `<section><h2>${path === '/edit' ? 'Edit synthetic record' : 'Find a synthetic record'}</h2><form method="get" action="/saved"><input name="synthetic" placeholder="Fictional search or record value"/><button type="submit">Save</button></form><button>Search</button><button>Edit</button><button>Back</button><button>Close</button><p>These clicks are ordinary local UI interactions. A click never proves a successful business operation.</p></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Synthetic demo workspace</title>${style}</head><body>${header}${body}</body></html>`;
}
for (const port of [4401, 4402]) {
  http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html(port, new URL(req.url, `http://localhost:${port}`).pathname));
  }).listen(port, '127.0.0.1', () => console.log(`Synthetic site: http://${port === 4401 ? '127.0.0.1' : 'localhost'}:${port}`));
}

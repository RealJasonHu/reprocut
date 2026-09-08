import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Purpose-built, client-state-only buggy app. No orders or external calls. */
export async function startDemo({ port = 0, fixed = false } = {}) {
  const html = (await readFile(new URL('./checkout.html', import.meta.url), 'utf8')).replace('__FIXED__', JSON.stringify(fixed));
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = await startDemo({ port: Number(process.env.PORT || 4173), fixed: process.argv.includes('--fixed') });
  console.log(`ReproCut sample shop: ${demo.url} (${process.argv.includes('--fixed') ? 'fixed' : 'buggy'})`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await demo.close(); process.exit(0); });
}

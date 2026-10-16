import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Ephemeral localhost-only test certificate; never disable certificate checks.
export async function publicationPeerTLS() {
  const dir = await mkdtemp(path.join(tmpdir(), 'skillhub-peer-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'pipe', timeout: 15000 });
    return { key: await readFile(path.join(dir, 'key.pem')), cert: await readFile(path.join(dir, 'cert.pem')),
      close: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

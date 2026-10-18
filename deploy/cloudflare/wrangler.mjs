import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const deploymentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(deploymentDir, '../..');
const result = spawnSync(process.execPath, [
    path.join(deploymentDir, 'node_modules/wrangler/bin/wrangler.js'),
    ...process.argv.slice(2),
], {
    cwd: deploymentDir,
    stdio: 'inherit',
    env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(repoRoot, '.cache/cloudflare-auth'),
        XDG_CACHE_HOME: path.join(repoRoot, '.cache/cloudflare-auth/cache'),
        WRANGLER_LOG_PATH: path.join(repoRoot, '.tmp/cloudflare-web/wrangler.log'),
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_AUTH_USE_KEYRING: 'true',
    },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;

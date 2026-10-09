import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
// Python's stdlib is used only to create the development deliverable, never at runtime.
mkdirSync('artifacts', { recursive: true });
const script = `import pathlib, zipfile
root=pathlib.Path('.').resolve()
excluded={'node_modules','dist','release','artifacts','.git','test-results','playwright-report'}
with zipfile.ZipFile(root/'artifacts'/'FTP-Studio-broncode.zip','w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(root.rglob('*')):
        rel=p.relative_to(root)
        if p.is_file() and not any(part in excluded for part in rel.parts):
            z.write(p,'ftp-studio/'+str(rel))
print('artifacts/FTP-Studio-broncode.zip')
`;
const result = spawnSync('python3', ['-c', script], { stdio: 'inherit' });
process.exit(result.status ?? 1);

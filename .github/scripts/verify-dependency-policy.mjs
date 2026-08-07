import fs from 'node:fs';
import path from 'node:path';

const appDirectory = process.argv[2];
if (!appDirectory) {
  throw new Error('Uso: node .github/scripts/verify-dependency-policy.mjs <directorio>');
}

const manifestPath = path.resolve(appDirectory, 'package.json');
const lockPath = path.resolve(appDirectory, 'package-lock.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const errors = [];

const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const forbiddenSpec = /^(?:https?:|git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|file:|link:|workspace:)/i;

for (const section of dependencySections) {
  for (const [name, spec] of Object.entries(manifest[section] || {})) {
    if (forbiddenSpec.test(spec)) {
      errors.push(`${section}.${name} usa un origen no permitido: ${spec}`);
    }
  }
}

const installedWithScripts = new Set();
for (const [packagePath, entry] of Object.entries(lock.packages || {})) {
  if (!packagePath.includes('node_modules/')) continue;

  const relativeName = packagePath.split('node_modules/').at(-1);
  const nameParts = relativeName.split('/');
  const name = relativeName.startsWith('@') ? nameParts.slice(0, 2).join('/') : nameParts[0];

  if (!entry.resolved) {
    errors.push(`${name}@${entry.version || '?'} no tiene URL resuelta en package-lock.json`);
  } else {
    try {
      const resolved = new URL(entry.resolved);
      if (resolved.protocol !== 'https:' || resolved.hostname !== 'registry.npmjs.org') {
        errors.push(`${name}@${entry.version || '?'} proviene de ${entry.resolved}`);
      }
    } catch {
      errors.push(`${name}@${entry.version || '?'} tiene una URL inválida: ${entry.resolved}`);
    }
  }

  if (!entry.integrity?.startsWith('sha512-')) {
    errors.push(`${name}@${entry.version || '?'} no tiene integridad SHA-512`);
  }

  if (entry.hasInstallScript) installedWithScripts.add(`${name}@${entry.version}`);
}

const approvedScripts = new Set();
for (const [identity, approved] of Object.entries(manifest.allowScripts || {})) {
  if (approved !== true || !/^(@[^/]+\/)?[^@/]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(identity)) {
    errors.push(`allowScripts debe aprobar una versión exacta con true: ${identity}`);
  } else {
    approvedScripts.add(identity);
  }
}

for (const identity of installedWithScripts) {
  if (!approvedScripts.has(identity)) errors.push(`${identity} tiene scripts de instalación sin revisar`);
}
for (const identity of approvedScripts) {
  if (!installedWithScripts.has(identity)) errors.push(`${identity} está aprobado pero no requiere scripts de instalación`);
}

if (errors.length) {
  console.error(`Política de dependencias rechazada para ${appDirectory}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Política válida para ${appDirectory}: registro oficial, integridad SHA-512 y ${installedWithScripts.size} scripts revisados.`,
);

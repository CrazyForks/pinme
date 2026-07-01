import fs from 'fs-extra';
import path from 'path';
import { createConfigError } from './cliError';

const PLACEHOLDERS = {
  apiUrl: '__PINME_VITE_API_URL__',
  authApiKey: '__PINME_AUTH_API_KEY__',
  authDomain: '__PINME_AUTH_DOMAIN__',
  authProjectId: '__PINME_AUTH_PROJECT_ID__',
  tenantId: '__PINME_TENANT_ID__',
} as const;

const PATCHABLE_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.css',
  '.json',
  '.map',
]);

interface PrebuiltDistWorkerData {
  api_domain?: string;
  public_client_config?: Record<string, any>;
}

export interface PatchPrebuiltFrontendDistResult {
  filesScanned: number;
  filesPatched: number;
  apiUrlReplacements: number;
  authReplacements: number;
}

function toReplacementValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value);
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  return content.split(needle).length - 1;
}

function listPatchableFiles(dir: string): string[] {
  const result: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      result.push(...listPatchableFiles(entryPath));
      continue;
    }

    if (entry.isFile() && PATCHABLE_EXTENSIONS.has(path.extname(entry.name))) {
      result.push(entryPath);
    }
  }

  return result;
}

export function patchPrebuiltFrontendDist(
  frontendDistDir: string,
  workerData: PrebuiltDistWorkerData,
): PatchPrebuiltFrontendDistResult {
  if (!workerData.api_domain) {
    throw createConfigError('`api_domain` is missing from project creation response.', [
      'Retry `pinme create`.',
      'If the problem persists, check the `/create_worker` API response.',
    ]);
  }

  if (!fs.existsSync(frontendDistDir)) {
    throw createConfigError('Prebuilt frontend output not found: `frontend/dist/`.', [
      'The template should ship a prebuilt `frontend/dist/`.',
      'Once dependencies finish installing, run `npm run build:frontend` in the project, then `pinme save`.',
    ]);
  }

  const authConfig = workerData.public_client_config ?? {};
  const replacements = new Map<string, string>([
    [PLACEHOLDERS.apiUrl, workerData.api_domain],
    [PLACEHOLDERS.authApiKey, toReplacementValue(authConfig.auth_api_key)],
    [PLACEHOLDERS.authDomain, toReplacementValue(authConfig.auth_domain)],
    [PLACEHOLDERS.authProjectId, toReplacementValue(authConfig.auth_project_id)],
    [PLACEHOLDERS.tenantId, toReplacementValue(authConfig.tenant_id)],
  ]);

  const files = listPatchableFiles(frontendDistDir);
  let filesPatched = 0;
  let apiUrlReplacements = 0;
  let authReplacements = 0;

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    let nextContent = content;

    for (const [placeholder, replacement] of replacements) {
      const count = countOccurrences(nextContent, placeholder);
      if (count === 0) {
        continue;
      }

      if (placeholder === PLACEHOLDERS.apiUrl) {
        apiUrlReplacements += count;
      } else {
        authReplacements += count;
      }

      nextContent = nextContent.split(placeholder).join(replacement);
    }

    if (nextContent !== content) {
      fs.writeFileSync(filePath, nextContent);
      filesPatched += 1;
    }
  }

  if (apiUrlReplacements === 0) {
    throw createConfigError('Prebuilt frontend dist is missing required Pinme config placeholder.', [
      'Expected to find `__PINME_VITE_API_URL__` in `frontend/dist`.',
      'Rebuild the template frontend from placeholder-enabled source before publishing the template.',
      'After dependencies finish installing, users can recover by running `npm run build:frontend` and `pinme save`.',
    ]);
  }

  return {
    filesScanned: files.length,
    filesPatched,
    apiUrlReplacements,
    authReplacements,
  };
}

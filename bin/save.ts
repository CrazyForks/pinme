import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import { execSync } from 'child_process';
import { getAuthHeaders } from './utils/webLogin';
import {
  INSTALL_LOG_FILE,
  INSTALL_EXITCODE_FILE,
  INSTALL_PID_FILE,
  installProjectDependencies,
  readBackgroundInstallStatus,
  readBackgroundInstallLogTail,
  stopBackgroundInstall,
} from './utils/installProjectDependencies';
import {
  bindDnsDomainV4,
  bindPinmeDomain,
  getRootDomain,
} from './utils/pinmeApi';
import {
  isDnsDomain,
  normalizeDomain,
  validateDnsDomain,
} from './utils/domainValidator';
import {
  CliError,
  createApiError,
  createCommandError,
  createConfigError,
  printCliError,
} from './utils/cliError';
import { APP_CONFIG, getPinmeApiUrl } from './utils/config';
import { uploadPath } from './services/uploadService';
import { printHighlightedUrl } from './utils/urlDisplay';
import tracker, { getTrackErrorReason } from './utils/tracker';
import {
  TRACK_EVENTS,
  TRACK_PAGES,
  resolveTrackAction,
} from './utils/trackerEvents';

const PROJECT_DIR = process.cwd();
interface SaveOptions {
  projectName?: string;
  name?: string;
  domain?: string;
}

// ============ 工具函数 ============

function loadConfig() {
  const configPath = path.join(PROJECT_DIR, 'pinme.toml');
  if (!fs.existsSync(configPath)) {
    throw createConfigError('`pinme.toml` not found in the current directory.', [
      'Run this command from the Pinme project root.',
      'If the project has not been initialized yet, create or restore `pinme.toml` first.',
    ]);
  }

  const configContent = fs.readFileSync(configPath, 'utf-8');
  const projectNameMatch = configContent.match(/project_name\s*=\s*"([^"]+)"/);

  return {
    project_name: projectNameMatch?.[1] || '',
  };
}

function getProjectManagementUrl(projectName: string): string {
  return `${APP_CONFIG.projectPeviewUrl}${projectName}`;
}
// ============ 后端部署 ============

function getMetadata() {
  const metadataPath = path.join(PROJECT_DIR, 'backend', 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    console.log(chalk.yellow('   Warning: metadata.json not found, using empty metadata'));
    return {};
  }
  return fs.readJsonSync(metadataPath);
}

function buildWorker() {
  console.log(chalk.blue('Building worker...'));
  try {
    execSync('npm run build:worker', {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
    });
    console.log(chalk.green('Worker built'));
  } catch (error: any) {
    if (isMissingDependencyError(error)) {
      throw dependenciesMissingError(
        'Worker build failed because a required CLI (e.g. `wrangler`) was not found. Project dependencies are missing or incomplete.',
      );
    }
    throw createCommandError('worker build', 'npm run build:worker', error, [
      'Fix the build error shown above, then rerun `pinme save`.',
    ]);
  }
}

// ============ 依赖检查 ============

/**
 * Build a clear, machine-readable error telling the caller (an AI agent or a
 * human) that dependencies are missing/incomplete and exactly how to fix it.
 * `pinme save` no longer installs dependencies itself — `pinme create` kicks off
 * the install in the background — so this is the single source of truth for the
 * "deps not ready" condition, whether detected up front or during a build.
 */
function dependenciesMissingError(summary: string, logTail?: string): CliError {
  const installLogPath = path.join(PROJECT_DIR, '.pinme-install.log');
  const suggestions = [
    'Run `npm install` in the project root, wait for it to finish, then rerun `pinme save`.',
  ];
  if (fs.existsSync(installLogPath)) {
    suggestions.push(
      `Background install log: ${installLogPath}`,
    );
  }

  const error = createConfigError(summary, suggestions);
  const trimmedTail = logTail?.trim();
  if (trimmedTail) {
    error.details = [
      ...error.details,
      'Install log (tail):',
      ...trimmedTail.split('\n').slice(-20),
    ];
  }
  return error;
}

/**
 * Detect a build failure that was actually caused by missing dependencies —
 * typically a CLI such as `wrangler` or `vite` not being on PATH (exit code 127
 * / "command not found"), or a module that could not be resolved.
 */
function isMissingDependencyError(error: any): boolean {
  const exitCode = error?.status ?? error?.code;
  if (exitCode === 127) {
    return true;
  }
  const haystack = [error?.message, error?.stderr, error?.stdout]
    .map((value) => String(value || ''))
    .join(' ')
    .toLowerCase();
  return /command not found|not found|is not recognized|cannot find module|cannot find package/.test(haystack);
}

/** Required build CLIs: worker build needs `wrangler`, frontend build needs `vite`. */
function dependenciesPresent(): boolean {
  return hasLocalBinary('wrangler') && hasLocalBinary('vite');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WAIT_FOR_INSTALL_TIMEOUT_MS = 15 * 1000;
const WAIT_POLL_INTERVAL_MS = 2000;

/**
 * Ensure dependencies are ready before building.
 *
 * `pinme save` no longer installs anything itself — `pinme create` kicks off the
 * install in the background. So here we:
 *   - return immediately if the build CLIs are already present;
 *   - otherwise inspect the background-install markers and, if it is still
 *     running, WAIT for it to finish with a live spinner (so the user isn't left
 *     guessing when they can save);
 *   - throw a clear, machine-readable error if the install failed, timed out, or
 *     was never started — telling the caller exactly to run `npm install`.
 */
async function ensureDependenciesReady(): Promise<void> {
  if (dependenciesPresent()) {
    console.log(chalk.gray('Dependencies are installed.'));
    return;
  }

  const initial = readBackgroundInstallStatus(PROJECT_DIR);

  if (initial.status === 'idle') {
    await installDependenciesInForeground();
    return;
  }

  if (initial.status === 'failed') {
    console.log(chalk.yellow(
      `Background dependency install failed with exit code ${initial.exitCode}. Retrying in this terminal...`,
    ));
    await installDependenciesInForeground();
    return;
  }

  if (initial.status === 'interrupted') {
    console.log(chalk.yellow('Background dependency install was interrupted. Continuing in this terminal...'));
    await installDependenciesInForeground();
    return;
  }

  // status === 'running' (or 'success' but CLIs not visible yet) → wait briefly,
  // then take over in the foreground so the user can see real npm output.
  const spinner = ora('Waiting briefly for background dependency install...').start();
  const startedAt = Date.now();

  while (true) {
    await sleep(WAIT_POLL_INTERVAL_MS);

    if (dependenciesPresent()) {
      spinner.succeed('Dependencies installed.');
      return;
    }

    const state = readBackgroundInstallStatus(PROJECT_DIR);

    if (state.status === 'failed') {
      spinner.fail('Background dependency install failed.');
      console.log(chalk.yellow(
        `Retrying dependency install in this terminal after exit code ${state.exitCode}...`,
      ));
      await installDependenciesInForeground();
      return;
    }

    if (state.status === 'interrupted') {
      spinner.fail('Background dependency install was interrupted.');
      await installDependenciesInForeground();
      return;
    }

    if (state.status === 'success') {
      // Install finished cleanly; trust it even if our CLI probe missed the bins.
      spinner.succeed('Dependencies installed.');
      return;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > WAIT_FOR_INSTALL_TIMEOUT_MS) {
      spinner.warn('Background dependency install is not ready yet; continuing in this terminal.');
      await stopBackgroundInstall(PROJECT_DIR);
      await installDependenciesInForeground();
      return;
    }

    spinner.text = `Waiting briefly for background dependency install... (${Math.round(elapsedMs / 1000)}s)`;
  }
}

async function installDependenciesInForeground(): Promise<void> {
  console.log(chalk.blue('Installing project dependencies...'));
  try {
    await stopBackgroundInstall(PROJECT_DIR);
    await installProjectDependencies(PROJECT_DIR);
  } catch (error: any) {
    throw dependenciesMissingError(
      'Project dependency install failed.',
      readBackgroundInstallLogTail(PROJECT_DIR) || error?.message,
    );
  }

  if (!dependenciesPresent()) {
    throw dependenciesMissingError(
      'Project dependencies were installed, but required build CLIs are still missing.',
      readBackgroundInstallLogTail(PROJECT_DIR),
    );
  }

  console.log(chalk.green('Project dependencies installed.'));
}

/**
 * Check whether an npm-installed binary is available in any of the workspace
 * `node_modules/.bin` directories (handles Windows `.cmd`/`.exe` shims too).
 */
/** Remove the background-install marker files once they are no longer needed. */
function cleanupInstallMarkers(): void {
  try {
    fs.removeSync(path.join(PROJECT_DIR, INSTALL_LOG_FILE));
    fs.removeSync(path.join(PROJECT_DIR, INSTALL_EXITCODE_FILE));
    fs.removeSync(path.join(PROJECT_DIR, INSTALL_PID_FILE));
  } catch {
    // Best-effort cleanup; never fail the command over leftover marker files.
  }
}

function hasLocalBinary(name: string): boolean {
  const binDirs = [
    path.join(PROJECT_DIR, 'node_modules', '.bin'),
    path.join(PROJECT_DIR, 'backend', 'node_modules', '.bin'),
    path.join(PROJECT_DIR, 'frontend', 'node_modules', '.bin'),
  ];
  const candidates = process.platform === 'win32'
    ? [name, `${name}.cmd`, `${name}.exe`, `${name}.ps1`]
    : [name];

  return binDirs.some((dir) => candidates.some((candidate) => fs.existsSync(path.join(dir, candidate))));
}

function getBuiltWorker(): { workerJsPath: string; modulePaths: string[] } {
  const distWorkerDir = path.join(PROJECT_DIR, 'dist-worker');

  if (!fs.existsSync(distWorkerDir)) {
    throw createConfigError('Built worker output not found: `dist-worker/`.', [
      'Make sure `npm run build:worker` completed successfully.',
    ]);
  }

  const workerJsPath = path.join(distWorkerDir, 'worker.js');
  if (!fs.existsSync(workerJsPath)) {
    throw createConfigError('Built worker entry file not found: `dist-worker/worker.js`.', [
      'Check the worker build output and bundler config.',
    ]);
  }

  const modulePaths: string[] = [];
  const files = fs.readdirSync(distWorkerDir);

  for (const file of files) {
    if (file.endsWith('.js') && file !== 'worker.js') {
      modulePaths.push(path.join(distWorkerDir, file));
    }
  }

  return { workerJsPath, modulePaths };
}

function getSqlFiles(): string[] {
  const sqlDir = path.join(PROJECT_DIR, 'db');
  if (!fs.existsSync(sqlDir)) {
    return [];
  }

  const files = fs.readdirSync(sqlDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  return files.map(f => path.join(sqlDir, f));
}

async function saveWorker(workerJsPath: string, modulePaths: string[], sqlFiles: string[], metadata: any, projectName: string) {
  console.log(chalk.blue('Saving worker to platform...'));
  console.log(chalk.gray(`Project: ${projectName}`));
  console.log(chalk.gray(`workerJsPath: ${workerJsPath}`));
  console.log(chalk.gray(`modulePaths: ${modulePaths}`));
  console.log(chalk.gray(`sqlFiles: ${sqlFiles}`));
  console.log(chalk.gray(`metadata: ${metadata}`));
  const apiUrl = `${getPinmeApiUrl('/save_worker')}?project_name=${encodeURIComponent(projectName)}`;
  const headers = getAuthHeaders();
  console.log(chalk.gray(`API URL: ${apiUrl}`));
  try {
    const FormData = (await import('formdata-node')).FormData;
    const Blob = (await import('formdata-node')).Blob;
    const formData = new FormData() as any;

    formData.append('metadata', new Blob([JSON.stringify(metadata)], {
      type: 'application/json',
    }), 'metadata.json');

    // worker.js
    const workerCode = fs.readFileSync(workerJsPath, 'utf-8');
    formData.append('worker.js', new Blob([workerCode], {
      type: 'application/javascript+module',
    }), 'worker.js');

    // Other modules
    for (const modulePath of modulePaths) {
      const filename = path.basename(modulePath);
      const content = fs.readFileSync(modulePath, 'utf-8');
      formData.append(filename, new Blob([content], {
        type: 'application/javascript+module',
      }), filename);
    }

    for (const sqlFile of sqlFiles) {
      const filename = path.basename(sqlFile);
      const content = fs.readFileSync(sqlFile, 'utf-8');
      formData.append('sql_file', new Blob([content], {
        type: 'application/sql',
      }), filename);
      console.log(chalk.gray(`   Including SQL: ${filename}`));
    }
    const response = await axios.put(apiUrl, formData, {
      headers: { ...headers },
      timeout: 120000,
    });
    console.log(chalk.gray(`   Response: ${JSON.stringify(response.data)}`));
    if (response.data) {
      console.log(chalk.green('Worker saved'));
      if (response.data?.data?.sql_results) {
        for (const result of response.data.data.sql_results) {
          console.log(chalk.gray(`   SQL ${result.filename}: ${result.status}`));
        }
      }
    } else {
      throw createApiError('worker save', { response: { data: response.data } }, [
        `Project: ${projectName}`,
        `Endpoint: ${apiUrl}`,
      ], [
        'Verify the project exists and your account has permission to update it.',
      ]);
    }
  } catch (error: any) {
    throw createApiError('worker save', error, [
      `Project: ${projectName}`,
      `Endpoint: ${apiUrl}`,
    ], [
      'Check whether backend metadata, SQL files, or worker bundle contains invalid content.',
    ]);
  }
}

// ============ 前端部署 ============

function buildFrontend() {
  console.log(chalk.blue('Building frontend...'));
  try {
    execSync('npm run build:frontend', {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
    });
    console.log(chalk.green('Frontend built'));
  } catch (error: any) {
    if (isMissingDependencyError(error)) {
      throw dependenciesMissingError(
        'Frontend build failed because a required CLI (e.g. `vite`) was not found. Project dependencies are missing or incomplete.',
      );
    }
    throw createCommandError('frontend build', 'npm run build:frontend', error, [
      'Fix the frontend build error shown above, then rerun `pinme save`.',
    ]);
  }
}

function updateFrontendUrlInConfig(configPath: string, frontendUrl: string): void {
  let config = fs.readFileSync(configPath, 'utf-8');

  if (config.includes('frontend_url')) {
    config = config.replace(
      /frontend_url\s*=\s*"[^"]*"/,
      `frontend_url = "${frontendUrl}"`,
    );
  } else {
    config = config.replace(
      /(project_name\s*=\s*"[^"]*"\n)/,
      `$1frontend_url = "${frontendUrl}"\n`,
    );
  }

  fs.writeFileSync(configPath, config);
}

async function deployFrontend(projectName: string): Promise<{ contentHash: string; publicUrl: string }> {
  console.log(chalk.blue('Deploying frontend to IPFS...'));
  try {
    const headers = getAuthHeaders();
    const uploadResult = await uploadPath(path.join(PROJECT_DIR, 'frontend', 'dist'), {
      action: 'project_save',
      projectName,
      uid: headers['token-address'],
    });
    updateFrontendUrlInConfig(path.join(PROJECT_DIR, 'pinme.toml'), uploadResult.publicUrl);
    return {
      contentHash: uploadResult.contentHash,
      publicUrl: uploadResult.publicUrl,
    };
  } catch (error: any) {
    throw createCommandError('frontend deploy', 'upload frontend/dist', error, [
      'Make sure `frontend/dist` exists and the upload API is reachable.',
    ]);
  }
}

async function bindFrontendDomain(
  domain: string,
  contentHash: string,
  projectName: string,
  headers: Record<string, string>,
): Promise<string> {
  const displayDomain = normalizeDomain(domain);
  const isDns = isDnsDomain(displayDomain);

  if (isDns) {
    const validation = validateDnsDomain(displayDomain);
    if (!validation.valid) {
      throw createConfigError(validation.message || 'Invalid domain format.', [
        'Use a complete domain like `example.com` for DNS binding.',
      ]);
    }
  }

  if (isDns) {
    const dnsResult = await bindDnsDomainV4(
      displayDomain,
      contentHash,
      headers['token-address'],
      headers['authentication-tokens'],
      projectName,
    );
    if (dnsResult.code !== 200) {
      throw new Error(dnsResult.msg || 'DNS binding failed');
    }
    return `https://${displayDomain}`;
  }

  const ok = await bindPinmeDomain(displayDomain, contentHash, projectName);
  if (!ok) {
    throw new Error('Pinme subdomain binding failed');
  }
  const rootDomain = await getRootDomain();
  return `https://${displayDomain}.${rootDomain}`;
}

// ============ 主函数 ============

/**
 * Save and deploy: build + upload worker + deploy frontend to IPFS
 */
export default async function saveCmd(options: SaveOptions): Promise<void> {
  try {
    // Check if user is logged in
    const headers = getAuthHeaders();
    if (!headers['authentication-tokens'] || !headers['token-address']) {
      throw createConfigError('No valid local login session was found.', [
        'Run `pinme login` and retry.',
      ]);
    }

    // Copy token to project directory for sub-commands
    const projectDir = options.projectName || options.name ? path.join(PROJECT_DIR, options.projectName || options.name!) : PROJECT_DIR;
    const tokenFileSrc = path.join(PROJECT_DIR, '.token.json');
    const tokenFileDst = path.join(projectDir, '.token.json');
    if (fs.existsSync(tokenFileSrc) && !fs.existsSync(tokenFileDst)) {
      fs.copySync(tokenFileSrc, tokenFileDst);
    }

    console.log(chalk.blue('Deploying to platform...\n'));

    console.log(chalk.gray(`Project dir: ${PROJECT_DIR}`));

    const config = loadConfig();
    const projectName = config.project_name;

    if (!projectName) {
      throw createConfigError('`project_name` is missing in `pinme.toml`.', [
        'Set `project_name = "your-project-name"` in `pinme.toml`.',
      ]);
    }

    console.log(chalk.gray(`Project: ${projectName}`));

    const apiUrl = `${getPinmeApiUrl('/save_worker')}?project_name=${encodeURIComponent(projectName)}`;
    console.log(chalk.gray(`API URL: ${apiUrl}`));

    // Backend: build + save
    console.log(chalk.blue('\n--- Backend ---'));
    await ensureDependenciesReady();
    buildWorker();

    const metadata = getMetadata();
    const { workerJsPath, modulePaths } = getBuiltWorker();
    console.log(chalk.gray(`Worker JS: ${workerJsPath}`));
    console.log(chalk.gray(`Module paths: ${JSON.stringify(modulePaths)}`));
    const sqlFiles = getSqlFiles();
    console.log(chalk.gray(`SQL files: ${JSON.stringify(sqlFiles)}`));
    await saveWorker(workerJsPath, modulePaths, sqlFiles, metadata, projectName);

    // Frontend: build + deploy
    console.log(chalk.blue('\n--- Frontend ---'));
    buildFrontend();
    const frontendResult = await deployFrontend(projectName);
    let finalFrontendUrl = frontendResult.publicUrl;

    if (options.domain) {
      finalFrontendUrl = await bindFrontendDomain(
        options.domain,
        frontendResult.contentHash,
        projectName,
        headers,
      );
    }

    console.log(chalk.blue('\n--- Access ---'));
    printHighlightedUrl('Frontend URL', finalFrontendUrl, 'primary');
    printHighlightedUrl(
      'Project Management URL',
      getProjectManagementUrl(projectName),
      'management',
    );
    console.log(chalk.green('\nDeployment complete.'));
    // Dependencies are installed and the deploy succeeded; the install markers
    // are no longer useful, so clean them up.
    cleanupInstallMarkers();
    void tracker.trackEvent(TRACK_EVENTS.projectSaveSuccess, TRACK_PAGES.deploy, {
      a: resolveTrackAction(TRACK_EVENTS.projectSaveSuccess),
      project_name: projectName,
      has_domain: Boolean(options.domain),
      domain_type: options.domain
        ? (isDnsDomain(options.domain) ? 'dns' : 'pinme_subdomain')
        : undefined,
    });
    process.exit(0);
  } catch (error: any) {
    void tracker.trackEvent(TRACK_EVENTS.projectSaveFailed, TRACK_PAGES.deploy, {
      a: resolveTrackAction(TRACK_EVENTS.projectSaveFailed),
      project_name: options.projectName || options.name,
      has_domain: Boolean(options.domain),
      reason: getTrackErrorReason(error),
    });
    printCliError(error, 'Save failed.');
    process.exit(1);
  }
}

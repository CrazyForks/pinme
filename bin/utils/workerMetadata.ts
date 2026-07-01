import { createConfigError } from './cliError';

interface WorkerMetadataBinding {
  name?: string;
  text?: unknown;
}

interface WorkerMetadata {
  project_name?: string;
  bindings?: WorkerMetadataBinding[];
}

function parseWorkerMetadata(metadataContent: string): WorkerMetadata {
  try {
    return JSON.parse(metadataContent);
  } catch (error) {
    throw createConfigError('Worker metadata must be valid JSON.', [
      'The `/create_worker` API should return JSON metadata for backend deployment.',
      'Retry `pinme create`.',
    ]);
  }
}

function isRealBindingValue(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  return Boolean(trimmed)
    && trimmed !== 'xxx'
    && trimmed !== 'project_name'
    && !trimmed.startsWith('__PINME_');
}

function findBinding(metadata: WorkerMetadata, name: string): WorkerMetadataBinding | undefined {
  return metadata.bindings?.find((binding) => binding.name === name);
}

export function validateWorkerMetadataForCreate(
  metadataContent: string,
  projectName: string,
): void {
  const metadata = parseWorkerMetadata(metadataContent);
  const apiKeyBinding = findBinding(metadata, 'API_KEY');
  const projectNameBinding = findBinding(metadata, 'PROJECT_NAME');

  if (!isRealBindingValue(apiKeyBinding?.text)) {
    throw createConfigError('Worker metadata is missing a real API_KEY binding.', [
      'The template metadata contains placeholder values and cannot be deployed as-is.',
      'Retry `pinme create` so Pinme can fetch fresh worker metadata from `/create_worker`.',
    ]);
  }

  if (projectNameBinding?.text !== projectName) {
    throw createConfigError('Worker metadata is missing a matching PROJECT_NAME binding.', [
      `Expected PROJECT_NAME binding text to be \`${projectName}\`.`,
      'Retry `pinme create` so Pinme can fetch fresh worker metadata from `/create_worker`.',
    ]);
  }

  if (metadata.project_name && metadata.project_name !== projectName) {
    throw createConfigError('Worker metadata project_name does not match the created project.', [
      `Expected metadata project_name to be \`${projectName}\`.`,
      `Received metadata project_name \`${metadata.project_name}\`.`,
    ]);
  }
}

export function getValidatedWorkerMetadataContent(
  metadata: unknown,
  projectName: string,
): string {
  if (!metadata) {
    throw createConfigError('Worker metadata is missing from project creation response.', [
      'The `/create_worker` API should return backend metadata before the prebuilt worker is deployed.',
      'Retry `pinme create`.',
    ]);
  }

  const metadataContent = typeof metadata === 'string'
    ? metadata
    : JSON.stringify(metadata, null, 2);

  validateWorkerMetadataForCreate(metadataContent, projectName);
  return metadataContent;
}

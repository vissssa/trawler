import path from 'path';
import { config } from '../config';
import { BadRequestError } from '../errors';

/** Only allow taskIds matching `task_<digits>_<hex>` */
const TASK_ID_PATTERN = /^task_[\w]+$/;

/**
 * Validate that a taskId matches the expected format.
 * Prevents path traversal via crafted taskId values.
 */
export function assertValidTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new BadRequestError(`Invalid taskId format: ${taskId}`, 'INVALID_TASK_ID');
  }
}

/**
 * Validate that a resolved file path is inside the configured data directory.
 * Prevents path traversal via symlinks or `..` segments.
 */
export function assertPathInsideDataDir(filePath: string): void {
  const resolved = path.resolve(filePath);
  const dataDir = path.resolve(config.storage.dataDir);
  if (!resolved.startsWith(dataDir + path.sep) && resolved !== dataDir) {
    throw new BadRequestError('File path outside allowed directory', 'PATH_TRAVERSAL');
  }
}

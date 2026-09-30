import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

// Opaque filenames keep mailbox addresses and other secret identifiers out of directory listings.
export class FileSecretStore {
  constructor(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new TypeError('Secret directory must be an absolute path');
    }
    this.directory = directory;
  }

  filePath(key) {
    if (typeof key !== 'string' || !key.length) throw new TypeError('Secret key is required');
    return path.join(this.directory, createHash('sha256').update(key).digest('hex'));
  }

  async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stats = await lstat(this.directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Unsafe secret directory');
    await chmod(this.directory, 0o700);
  }

  async get(key) {
    await this.prepare();
    const filename = this.filePath(key);
    let handle;
    try {
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = await handle.stat();
      if (!stats.isFile() || (stats.mode & 0o077) !== 0) throw new Error('Unsafe secret file');
      return await handle.readFile({ encoding: 'utf8' });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('Unable to read secret');
    } finally {
      await handle?.close();
    }
  }

  async set(key, value) {
    if (typeof value !== 'string' || !value.length) throw new TypeError('Secret value is required');
    await this.prepare();
    const filename = this.filePath(key);
    const temporary = `${filename}.${randomBytes(12).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(value, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, filename);
      const directoryHandle = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      await handle?.close();
      await unlink(temporary).catch(() => {});
      throw new Error('Unable to write secret');
    }
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';

export interface FileStorage {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<{ data: Buffer; mime: string } | null>;
  delete(key: string): Promise<void>;
}

class LocalStorage implements FileStorage {
  constructor(private root: string) {}
  private p(key: string): string {
    const safe = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    return path.join(this.root, safe);
  }
  async put(key: string, data: Buffer): Promise<void> {
    const file = this.p(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }
  async get(key: string) {
    try {
      const data = await fs.readFile(this.p(key));
      return { data, mime: 'image/jpeg' };
    } catch {
      return null;
    }
  }
  async delete(key: string): Promise<void> {
    await fs.rm(this.p(key), { force: true });
  }
}

class AzureBlobStorage implements FileStorage {
  private containerPromise: Promise<import('@azure/storage-blob').ContainerClient> | null = null;

  private container() {
    if (!this.containerPromise) {
      this.containerPromise = (async () => {
        const { BlobServiceClient } = await import('@azure/storage-blob');
        let service;
        if (config.storage.azureConnectionString) {
          service = BlobServiceClient.fromConnectionString(config.storage.azureConnectionString);
        } else {
          // Managed identity in Azure – no storage keys in config.
          const { DefaultAzureCredential } = await import('@azure/identity');
          service = new BlobServiceClient(
            `https://${config.storage.azureAccount}.blob.core.windows.net`,
            new DefaultAzureCredential(),
          );
        }
        return service.getContainerClient(config.storage.azureContainer);
      })();
    }
    return this.containerPromise;
  }

  async put(key: string, data: Buffer, mime: string): Promise<void> {
    const c = await this.container();
    await c.getBlockBlobClient(key).uploadData(data, { blobHTTPHeaders: { blobContentType: mime } });
  }
  async get(key: string) {
    const c = await this.container();
    const blob = c.getBlockBlobClient(key);
    try {
      const buf = await blob.downloadToBuffer();
      return { data: buf, mime: 'image/jpeg' };
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    const c = await this.container();
    await c.getBlockBlobClient(key).deleteIfExists();
  }
}

let instance: FileStorage | null = null;
export function getStorage(): FileStorage {
  if (!instance) {
    instance =
      config.storage.provider === 'azure' ? new AzureBlobStorage() : new LocalStorage(config.storage.localDir);
  }
  return instance;
}

export function setStorageForTests(s: FileStorage | null): void {
  instance = s;
}

export class MemoryStorage implements FileStorage {
  files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    const d = this.files.get(key);
    return d ? { data: d, mime: 'image/jpeg' } : null;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

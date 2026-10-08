/** Collect files from drag & drop (folders included) and file inputs. */

export interface DroppedFile {
  file: File;
  /** Path relative to the dropped root (or just the file name). */
  relPath: string;
}

export async function filesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<DroppedFile[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries: FileSystemEntry[] = [];
  for (const item of items) {
    if (item.kind !== "file" || typeof item.webkitGetAsEntry !== "function") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }

  // Fallback for browsers without the entries API.
  if (entries.length === 0) {
    return Array.from(dataTransfer.files).map((file) => ({
      file,
      relPath: file.name,
    }));
  }

  const out: DroppedFile[] = [];
  for (const entry of entries) {
    await readEntry(entry, "", out);
  }
  return out;
}

/** `<input type="file" webkitdirectory>` (or a plain multiple file input). */
export function filesFromInputList(list: FileList): DroppedFile[] {
  return Array.from(list).map((file) => {
    const withPath = file as File & { webkitRelativePath?: string };
    return { file, relPath: withPath.webkitRelativePath || file.name };
  });
}

function readEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: DroppedFile[],
): Promise<void> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as FileSystemFileEntry).file(
        (file) => {
          out.push({ file, relPath: prefix + file.name });
          resolve();
        },
        (err) => reject(err),
      );
    });
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    return readAllEntries(reader).then(async (children) => {
      for (const child of children) {
        await readEntry(child, `${prefix}${entry.name}/`, out);
      }
    });
  }
  return Promise.resolve();
}

function readAllEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all);
            return;
          }
          all.push(...batch);
          readBatch();
        },
        (err) => reject(err),
      );
    };
    readBatch();
  });
}

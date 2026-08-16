/** What the ingester can actually read (mirrors the API's accepted types). */
export const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.pdf'];

export const ACCEPT_ATTR = '.txt,.md,.pdf,text/plain,text/markdown,application/pdf';

/**
 * How many files one drop may upload.
 *
 * Uploads run one at a time (each is its own request and its own ingest job), so
 * a 40-file drop is a long silent queue where a failure near the end is
 * impossible to attribute. Five is small enough that the whole batch finishes
 * while the person is still watching it.
 */
export const MAX_FILES_PER_UPLOAD = 5;

export interface UploadPlan<T> {
  /** Files that will actually be uploaded, in the order they were given. */
  accepted: T[];
  /** Names rejected for type — the ingester cannot read them at all. */
  unreadable: string[];
  /** Names dropped for being over the batch limit — re-drop them and they work. */
  deferred: string[];
}

/**
 * Split a dropped/selected batch into what to upload, what can never be read,
 * and what is merely over the per-drop limit.
 *
 * The last two are kept APART on purpose. "Skipped 6 files" reads as one
 * failure, but `photo.png` will never work and `policy-6.pdf` works fine on the
 * next drop — telling someone to retry a file that cannot succeed, or to give up
 * on one that can, is the whole cost of merging them.
 *
 * Type-rejects are counted before the limit so a batch of five PDFs plus a
 * screenshot still uploads all five PDFs.
 */
export function planUpload<T extends { name: string }>(
  files: T[],
  max: number = MAX_FILES_PER_UPLOAD,
): UploadPlan<T> {
  const readable: T[] = [];
  const unreadable: string[] = [];

  for (const file of files) {
    if (isReadable(file.name)) {
      readable.push(file);
    } else {
      unreadable.push(file.name);
    }
  }

  return {
    accepted: readable.slice(0, max),
    unreadable,
    deferred: readable.slice(max).map((f) => f.name),
  };
}

function isReadable(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

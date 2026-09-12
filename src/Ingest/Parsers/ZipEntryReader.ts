import { Readable } from 'node:stream';
import yauzl from 'yauzl';

/**
 * Streams a single entry out of a zip archive without expanding the archive
 * to disk.
 *
 * BTS On-Time Performance months are ~31MB compressed and ~275MB
 * uncompressed. Extracting them would write 3.3GB across a 12-month ingest
 * for no benefit, so the CSV entry is decompressed on the fly and consumed
 * row by row.
 */
export class ZipEntryReader {
  /**
   * Opens the first entry whose filename matches the predicate and returns a
   * read stream over its decompressed contents.
   */
  public OpenEntry(archivePath: string, matches: (fileName: string) => boolean) {
    return new Promise<Readable>((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true }, (openError, zipFile) => {
        if (openError || !zipFile) {
          reject(openError ?? new Error(`Unable to open archive: ${archivePath}`));
          return;
        }

        let found = false;

        zipFile.on('entry', (entry: yauzl.Entry) => {
          if (!matches(entry.fileName)) {
            zipFile.readEntry();
            return;
          }

          found = true;
          zipFile.openReadStream(entry, (streamError, readStream) => {
            if (streamError || !readStream) {
              zipFile.close();
              reject(streamError ?? new Error(`Unable to read entry: ${entry.fileName}`));
              return;
            }
            // Closing the zipFile is deferred until the entry stream ends,
            // otherwise the underlying fd is pulled out from under the reader.
            readStream.on('end', () => zipFile.close());
            readStream.on('error', () => zipFile.close());
            resolve(readStream as unknown as Readable);
          });
        });

        zipFile.on('end', () => {
          if (!found) {
            zipFile.close();
            reject(new Error(`No matching entry found in archive: ${archivePath}`));
          }
        });

        zipFile.on('error', (zipError: Error) => {
          zipFile.close();
          reject(zipError);
        });

        zipFile.readEntry();
      });
    });
  }

  /** Convenience wrapper for archives containing a single CSV. */
  public OpenCsvEntry(archivePath: string) {
    return this.OpenEntry(archivePath, (fileName) => fileName.toLowerCase().endsWith('.csv'));
  }
}

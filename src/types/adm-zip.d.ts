declare module 'adm-zip' {
  export interface ZipEntry {
    entryName: string;
    isDirectory: boolean;
    getData(): Buffer;
  }

  export default class AdmZip {
    constructor(fileName?: string | Buffer);
    getEntry(entryName: string): ZipEntry | null;
    getEntries(): ZipEntry[];
  }
}

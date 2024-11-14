import {
  BlossomClient,
  type BlobDescriptor,
  type Signer,
} from "blossom-client-sdk";
import { nanoid } from "nanoid";
import mime from "mime";
import { EventEmitter } from "eventemitter3";

import type { Drive } from "./Drive.js";
import {
  correctFileMimeType,
  readFileSystemDirectory,
  readFileSystemFile,
} from "./helpers.js";
import { joinPath } from "./FileTree/methods.js";
import { EncryptedDrive } from "./EncryptedDrive.js";

export type UploadableItem = FileList | File | FileSystemDirectoryEntry;

export type UploadFileStatus = {
  complete: boolean;
  pending: boolean;
  serversComplete: number;
  results: Record<
    string,
    { success: true; blob: BlobDescriptor } | { success: false; error: Error }
  >;
};

type EventMap = {
  start: [Upload];
  progress: [number];
  complete: [Upload];
};

/** General purpose class for uploading blobs to drives */
export class Upload extends EventEmitter<EventMap> {
  drive: Drive | EncryptedDrive;

  /** The array of blossom servers to upload the files to */
  servers: string[];

  /** The signer used to sign auth events */
  signer: Signer;

  /** The base path in the drive to add all the files to */
  basePath: string;

  complete = false;
  running = false;

  /** The array of files to upload to the drive */
  files: { id: string; file: File; path: string }[] = [];
  /** Current upload status for each file */
  status: Record<string, UploadFileStatus> = {};

  /** The Blobs returned for each file upload, blobs[server][file.id] */
  blobs: Record<string, Record<string, BlobDescriptor>> = {};
  /** The Error returned for each file upload, blobs[server][file.id] */
  errors: Record<string, Record<string, Error>> = {};

  /** Total upload progress */
  get progress() {
    const serverProgress: Record<string, number> = {};
    for (const server of this.servers) {
      const blobs = this.blobs[server]
        ? Object.keys(this.blobs[server]).length
        : 0;
      const errors = this.errors[server]
        ? Object.keys(this.errors[server]).length
        : 0;
      serverProgress[server] = (blobs + errors) / this.files.length;
    }

    return (
      Object.values(serverProgress).reduce((t, v) => v + t, 0) /
      this.servers.length
    );
  }

  constructor(
    drive: Drive | EncryptedDrive,
    basePath: string,
    servers: string[],
    signer: Signer,
  ) {
    super();
    this.drive = drive;
    this.servers = servers;
    this.basePath = basePath;
    this.signer = signer;
  }

  /** Add a single file to the upload */
  async addFile(file: File, path?: string) {
    path =
      path || (file.webkitRelativePath ? file.webkitRelativePath : file.name);

    file = correctFileMimeType(file);

    this.files.push({ id: nanoid(), file, path });
  }

  /** Add a FileList to the upload */
  async addFileList(fileList: FileList) {
    for (const file of fileList) {
      await this.addFile(file);
    }
  }

  /** Read all files from a FileSystemEntry and add to the upload */
  async addFileSystemEntry(entry: FileSystemEntry) {
    if (entry instanceof FileSystemFileEntry && entry.isFile) {
      try {
        let file = await readFileSystemFile(entry);
        file = correctFileMimeType(file);
        this.files.push({ id: nanoid(), file, path: entry.fullPath });
      } catch (e) {
        console.log("Failed to add" + entry.fullPath);
        console.log(e);
      }
    } else if (entry instanceof FileSystemDirectoryEntry && entry.isDirectory) {
      const entries = await readFileSystemDirectory(entry);
      for (const e of entries) await this.addFileSystemEntry(e);
    }
  }

  /** Start uploading the files to the servers */
  async upload() {
    if (this.running || this.complete) return;
    this.running = true;
    this.emit("start", this);
    for (const upload of this.files) {
      this.status[upload.id] = {
        complete: false,
        pending: true,
        serversComplete: 0,
        results: {},
      };
    }

    for (const upload of this.files) {
      const status = this.status[upload.id];
      let _file = upload.file;

      status.pending = false;
      this.emit("progress", this.progress);

      if (this.drive instanceof EncryptedDrive) {
        const blob = await this.drive.encryptBlob(_file);
        _file = new File([blob], "encrypted.bin", {
          type: "application/octet-stream",
        });
      }

      const token = await BlossomClient.createUploadAuth(
        this.signer,
        _file,
        `Upload ${_file.name}`,
      );

      for (const server of this.servers) {
        if (!this.blobs[server]) this.blobs[server] = {};
        if (!this.errors[server]) this.errors[server] = {};

        try {
          const blob = await BlossomClient.uploadBlob(server, _file, {
            auth: token,
          });
          this.blobs[server][upload.id] = blob;
          status.results[server] = { success: true, blob };
          this.drive.setFile(joinPath(this.basePath, upload.path), {
            sha256: blob.sha256,
            size: blob.size,
            type:
              upload.file.type ||
              mime.getType(upload.file.name) ||
              blob.type ||
              "",
          });
        } catch (error) {
          if (error instanceof Error) {
            this.errors[server][upload.id] = error;
            status.results[server] = { success: false, error };
          }
        }
        status.serversComplete++;
        this.emit("progress", this.progress);
      }

      status.complete = true;
      this.emit("progress", this.progress);
    }

    await this.drive.save();

    this.complete = true;
    this.emit("complete", this);
  }
}

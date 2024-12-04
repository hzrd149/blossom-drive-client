import {
  BlossomClient,
  type EventTemplate,
  type SignedEvent,
} from "blossom-client-sdk";
import { base64 } from "@scure/base";

import { Drive, getEmptyMetadata, type DriveMetadata } from "./Drive.js";
import { decrypt, encrypt } from "./crypto.js";
import { TreeFolder } from "./FileTree/TreeFolder.js";
import type { Path } from "./FileTree/methods.js";

export const ENCRYPTED_DRIVE_KIND = 30564;
export const DEFAULT_SCRYPT_LOGN = 10;

const drivePasswords = new WeakMap<EncryptedDrive, string>();

export class EncryptedDrive extends Drive {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  logn = DEFAULT_SCRYPT_LOGN;
  locked = true;

  /**
   * Attempts to decrypt the drive with the provided password
   * If successful it will set locked=false and save the password in memory
   */
  async unlock(password: string) {
    if (!this.event) throw new Error("No Event");
    if (!this.locked) throw new Error("Already unlocked");
    try {
      drivePasswords.set(this, password);
      this.locked = false;
      await this.resetFromEvent();
    } catch (e) {
      drivePasswords.delete(this);
      this.locked = true;
      throw e;
    }
  }
  lock() {
    if (!this.locked) {
      drivePasswords.delete(this);
      this.locked = false;
      this._metadata = getEmptyMetadata();
      this.tree = new TreeFolder("");
    }
  }

  /** Used to set the password on new drives */
  setPassword(password: string, logn = DEFAULT_SCRYPT_LOGN) {
    if (this.locked && !drivePasswords.has(this)) {
      drivePasswords.set(this, password);
      this.logn = logn;
    }
  }

  protected readEvent(event: EventTemplate | SignedEvent): DriveMetadata {
    const password = drivePasswords.get(this);
    if (!password) throw new Error("No password provided");

    const data = decrypt(base64.decode(event.content), password);
    const plaintext = this.decoder.decode(data);
    const tags = JSON.parse(plaintext);

    this.locked = false;

    return super.readEvent({ ...event, content: "", tags, created_at: 0 });
  }

  protected createEventTemplate(): EventTemplate {
    const password = drivePasswords.get(this);
    if (!password) throw new Error("No password set");

    const template = super.createEventTemplate();
    const plaintext = this.encoder.encode(JSON.stringify(template.tags));
    const data = encrypt(plaintext, password, this.logn);
    const ciphertext = base64.encode(data);
    template.kind = ENCRYPTED_DRIVE_KIND;
    template.content = ciphertext;
    // only keep the "d" and "scrypt-logn" tags public
    template.tags = template.tags.filter((t) => t[0] === "d");
    template.tags.push(["scrypt-logn", String(this.logn)]);
    return template;
  }

  update(event: EventTemplate | SignedEvent): boolean {
    if (!this.locked) return super.update(event);
    else if (!this.event || event.created_at > this.event.created_at) {
      this.event = event;

      this._metadata.identifier =
        event.tags.find((t) => t[0] === "d")?.[1] ?? "";

      const logn = parseInt(
        event.tags.find((t) => t[0] === "scrypt-logn")?.[1] ?? "",
      );
      if (Number.isFinite(logn) && logn > 0 && logn <= 22) this.logn = logn;
      else this.logn = DEFAULT_SCRYPT_LOGN;

      if (Reflect.has(event, "pubkey"))
        this._metadata.pubkey = Reflect.get(event, "pubkey");

      return true;
    }
    return false;
  }

  /** Encrypt a Blob with the drives password */
  async encryptBlob(blob: Blob) {
    if (this.locked) throw new Error("Drive locked");
    const password = drivePasswords.get(this);
    if (!password) throw new Error("No password provided");

    const buffer = await blob.arrayBuffer();
    const ciphertext = encrypt(new Uint8Array(buffer), password, this.logn);
    return new Blob([ciphertext], { type: "application/octet-stream" });
  }

  /** Decrypt a Blob with the drives password */
  async decryptBlob(blob: Blob, type?: string) {
    if (this.locked) throw new Error("Drive locked");
    const password = drivePasswords.get(this);
    if (!password) throw new Error("No password provided");

    const buffer = await blob.arrayBuffer();
    const plaintext = decrypt(new Uint8Array(buffer), password);
    return new Blob([plaintext], { type });
  }

  /** Download and Decrypt a file at the provided path */
  async downloadFile(path: Path, additionalServers: string[] = []) {
    if (this.locked) throw new Error("Drive locked");
    const password = drivePasswords.get(this);
    if (!password) throw new Error("No password provided");

    const file = this.getFile(path);
    const servers = [...this.servers];
    for (const server of additionalServers) {
      if (!servers.includes(server)) servers.push(server);
    }

    for (const server of servers) {
      try {
        const res = await BlossomClient.downloadBlob(server, file.sha256);
        const data = await res.blob();
        const blob = await this.decryptBlob(data);
        return new File([blob], file.name, { type: file.type });
      } catch (e) {}
    }
    return null;
  }
}

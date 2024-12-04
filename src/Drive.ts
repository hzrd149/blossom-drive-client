import {
  type SignedEvent,
  type EventTemplate,
  type Signer,
  BlossomClient,
} from "blossom-client-sdk";
import { EventEmitter } from "eventemitter3";
import { naddrEncode } from "nostr-tools/nip19";

import { TreeFolder } from "./FileTree/TreeFolder.js";
import { createTreeFromTags, updateTreeInTags } from "./nostr.js";
import {
  getFile,
  getFolder,
  getPath,
  setFile,
  type Path,
  remove,
  move,
  extname,
} from "./FileTree/methods.js";
import type { FileMetadata } from "./FileTree/TreeFile.js";
import { TreeFile } from "./FileTree/TreeFile.js";
import { getExtension } from "./helpers.js";

function now() {
  return Math.floor(Date.now() / 1000);
}

export const DRIVE_KIND = 30563;

/**
 * A simple method responsible for publish a signer nostr event to relays
 * @example
 * function publisher(event){
 *   const relay = Relay.connect("wss://relay.example.com");
 *
 *   relay.publish(event)
 * }
 */
export type Publisher = (event: SignedEvent) => Promise<void>;
export type DriveMetadata = {
  name: string;
  identifier: string;
  description: string;
  servers: string[];
  pubkey?: string;
  treeTags: string[][];
};

export const getEmptyMetadata = () =>
  ({
    name: "",
    identifier: "",
    description: "",
    servers: [],
    treeTags: [],
  }) satisfies DriveMetadata;

type EventMap = {
  change: [Drive];
  update: [Drive];
};

export class Drive extends EventEmitter<EventMap> {
  tree: TreeFolder;
  event?: EventTemplate | SignedEvent;

  /** whether the drive has been modified and needs to be saved */
  modified = false;

  protected _metadata: DriveMetadata = getEmptyMetadata();
  get pubkey() {
    return this._metadata.pubkey;
  }
  get identifier() {
    return this._metadata.identifier;
  }
  set identifier(v: string) {
    this._metadata.identifier = v;
    this.modified = true;
    this.emit("change", this);
  }
  get name() {
    return this._metadata.name;
  }
  set name(v: string) {
    this._metadata.name = v;
    this.modified = true;
    this.emit("change", this);
  }
  get description() {
    return this._metadata.description;
  }
  set description(v: string) {
    this._metadata.description = v;
    this.modified = true;
    this.emit("change", this);
  }
  get servers() {
    return this._metadata.servers;
  }
  set servers(v: string[]) {
    this._metadata.servers = v;
    this.modified = true;
    this.emit("change", this);
  }

  signer: Signer;
  publisher: Publisher;

  get address() {
    if (!this.event) return "";
    return this.pubkey
      ? naddrEncode({
          identifier: this.identifier,
          pubkey: this.pubkey,
          kind: this.event.kind,
        })
      : "";
  }

  static fromEvent(event: SignedEvent, signer: Signer, publisher: Publisher) {
    const drive = new Drive(signer, publisher);
    drive.update(event);
    return drive;
  }

  constructor(signer: Signer, publisher: Publisher) {
    super();
    this.signer = signer;
    this.publisher = publisher;
    this.tree = new TreeFolder("");
  }

  protected createEventTemplate() {
    let newTags = updateTreeInTags(this.event?.tags || [], this.tree);

    const removeTags = ["name", "description", "d", "r", "server"];
    newTags = newTags.filter((t) => !removeTags.includes(t[0]));

    for (const server of this.servers)
      newTags.unshift(["server", new URL("/", server).toString()]);

    newTags.unshift(
      ["name", this.name],
      ["description", this.description],
      ["d", this.identifier],
    );

    const template: EventTemplate = {
      kind: DRIVE_KIND,
      content: this.event?.content || "",
      created_at: now(),
      tags: newTags,
    };

    return template;
  }
  protected readEvent(event: EventTemplate | SignedEvent): DriveMetadata {
    const name =
      event.tags.find((t) => t[0] === "name")?.[1] ?? this.identifier ?? "";
    const description =
      event.tags.find((t) => t[0] === "description")?.[1] ?? "";
    const servers =
      event.tags
        .filter((t) => (t[0] === "r" || t[0] === "server") && t[1])
        .map((t) => new URL("/", t[1]).toString()) || [];

    const identifier = event.tags.find((t) => t[0] === "d")?.[1];
    if (!identifier) throw new Error("Missing d tag");

    let pubkey: string | undefined = undefined;
    if (Reflect.has(event, "pubkey")) pubkey = Reflect.get(event, "pubkey");

    const treeTags = event.tags.filter(
      (t) => t[0] === "x" || t[0] === "folder",
    );

    return { name, description, servers, identifier, pubkey, treeTags };
  }

  /** Save any pending changes to nostr */
  async save() {
    if (!this.modified) return;
    const signed = await this.signer(this.createEventTemplate());
    await this.publisher(signed);
    this.update(signed);
    return signed;
  }

  update(event: EventTemplate | SignedEvent) {
    if (!this.event || event.created_at > this.event.created_at) {
      this.event = event;

      this.resetFromEvent();
      this.emit("update", this);
      return true;
    }
    return false;
  }

  protected resetFromEvent() {
    if (!this.event) return;
    this._metadata = this.readEvent(this.event);
    this.tree = createTreeFromTags(this._metadata.treeTags);
    this.modified = false;
    this.emit("change", this);
  }
  /** Reset any pending changes */
  reset() {
    if (this.modified) {
      this.resetFromEvent();
      this.modified = false;
      this.emit("change", this);
    }
  }

  /** Gets the file or folder at the path */
  getPath(path: Path, create = false) {
    return getPath(this.tree, path, create);
  }

  /** Gets the folder at the path, pass create=true in to create an empty folder */
  getFolder(path: Path, create = false) {
    const folder = getFolder(this.tree, path, create);
    if (create) this.modified = true;
    return folder;
  }
  getFile(path: Path) {
    return getFile(this.tree, path);
  }

  getFileURL(path: Path, additionalServers: string[] = []) {
    const file = this.getFile(path);
    const servers = [...this.servers];
    for (const server of additionalServers) {
      if (!servers.includes(server)) servers.push(server);
    }

    const ext = extname(file.name) ?? getExtension(file.type) ?? "";
    return new URL("/" + file.sha256 + ext, servers[0]).toString();
  }

  /** Downloads the file at the path */
  async downloadFile(path: Path, additionalServers: string[] = []) {
    const file = this.getFile(path);
    const servers = [...this.servers];
    for (const server of additionalServers) {
      if (!servers.includes(server)) servers.push(server);
    }

    for (const server of servers) {
      try {
        const res = await BlossomClient.downloadBlob(server, file.sha256);
        const blob = await res.blob();
        return new File([blob], file.name, { type: file.type });
      } catch (e) {}
    }
    return null;
  }

  /** Removes the file or folder at the path */
  remove(path: Path) {
    remove(this.tree, path);
    this.modified = true;
    this.emit("change", this);
  }

  /** Moves the file or folder from src to dest */
  move(src: Path, dest: Path) {
    move(this.tree, src, dest);
    this.modified = true;
    this.emit("change", this);
  }

  /** Updates or creates a new file at the path */
  setFile(path: Path, metadata: FileMetadata) {
    const file = setFile(this.tree, path, metadata);
    this.modified = true;
    this.emit("change", this);
    return file;
  }

  /** Checks if there is a file with a matching sha256 hash  */
  hasHash(sha256: string) {
    const walk = (entry: TreeFolder) => {
      for (const child of entry) {
        if (child instanceof TreeFile && child.sha256 === sha256) return true;
        if (child instanceof TreeFolder && walk(child)) return true;
      }
      return false;
    };
    return walk(this.tree);
  }

  /**
   * Iterate over the files
   * @example
   * for(let fileOrFolder of drive){
   *   if(fileOrFolder instanceof TreeFolder){
   *     // keep looping
   *   }
   *   else if(fileOrFolder instanceof TreeFile){
   *     console.log(fileOrFolder.path)
   *   }
   * }
   */
  [Symbol.iterator]() {
    return this.tree[Symbol.iterator]();
  }
}

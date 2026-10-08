// MinIO / S3 object-storage client for attachments (INNOBOX_SPEC.md §11). Bytes are written
// here on upload and read back only through the authenticated download gateway (invariant 4) —
// presigned/direct URLs are never emitted. The `StorageClient` interface is deliberately small
// so the store/worker can be unit-tested against an in-memory fake (MinIO is not reachable from
// the host in dev/CI). Lazy singleton behind a Proxy-free getter: importing this module never
// opens a socket; the real client materializes on first use (mirrors lib/db.ts).
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

/** The minimal object-store surface the attachment code depends on — injectable for tests.
 *  The multipart methods back the §11 chunked-upload protocol: the server relays each client
 *  chunk to `uploadPart`, then reassembles the single immutable object on `completeMultipartUpload`.
 *  Chunks flow through the server only — no presigned/direct-store URLs are ever emitted
 *  (invariant 4). */
export interface StorageClient {
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
  getObject(key: string): Promise<Uint8Array>;
  deleteObject(key: string): Promise<void>;
  /** Open a multipart upload for `key`; returns the object-store upload id. */
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  /** Relay one chunk as part `partNumber` (1-based) of an open multipart upload. */
  uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<void>;
  /** Assemble all uploaded parts into the final object (parts are enumerated server-side). */
  completeMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** Discard an open multipart upload and free its already-uploaded parts. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : undefined;
}

export function attachmentBucket(): string {
  return env("S3_BUCKET") ?? "innobox-attachments";
}

// The compose network wires S3_ACCESS_KEY / S3_SECRET_KEY into the containers; the spec/env
// docs also name S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY, and both default to the MinIO root
// creds in dev — accept every alias so the same code runs in compose and against real S3.
function accessKeyId(): string | undefined {
  return env("S3_ACCESS_KEY_ID") ?? env("S3_ACCESS_KEY") ?? env("MINIO_ROOT_USER");
}
function secretAccessKey(): string | undefined {
  return env("S3_SECRET_ACCESS_KEY") ?? env("S3_SECRET_KEY") ?? env("MINIO_ROOT_PASSWORD");
}

async function streamToUint8Array(body: unknown): Promise<Uint8Array> {
  // The AWS SDK returns a Node Readable in Node runtimes; transformToByteArray() is the
  // supported way to buffer it fully without depending on the stream type.
  const b = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (b && typeof b.transformToByteArray === "function") return b.transformToByteArray();
  // Fallback: async-iterate a Node Readable.
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

class S3StorageClient implements StorageClient {
  private readonly client: S3Client;
  private readonly bucket: string;
  private bucketEnsured = false;

  constructor() {
    const endpoint = env("S3_ENDPOINT");
    const region = env("S3_REGION") ?? "us-east-1";
    const id = accessKeyId();
    const secret = secretAccessKey();
    this.bucket = attachmentBucket();
    this.client = new S3Client({
      endpoint,
      region,
      forcePathStyle: true, // MinIO requires path-style addressing
      credentials: id && secret ? { accessKeyId: id, secretAccessKey: secret } : undefined,
    });
  }

  /** Create the bucket on first use if it doesn't already exist (idempotent). */
  private async ensureBucket(): Promise<void> {
    if (this.bucketEnsured) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (err) {
        // A concurrent creator (another web replica) may have won the race — tolerate that.
        const name = (err as { name?: string }).name ?? "";
        if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
      }
    }
    this.bucketEnsured = true;
  }

  async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async getObject(key: string): Promise<Uint8Array> {
    await this.ensureBucket();
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return streamToUint8Array(res.Body);
  }

  async deleteObject(key: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    await this.ensureBucket();
    const res = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }));
    if (!res.UploadId) throw new Error("object store did not return an upload id");
    return res.UploadId;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<void> {
    await this.client.send(new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body }));
  }

  async completeMultipartUpload(key: string, uploadId: string): Promise<void> {
    // Enumerate the parts the daemon already holds (their ETags) rather than tracking them in
    // the web tier — part uploads can land on any replica, so the store is authoritative. Our
    // files split into at most ~40 parts (200 MB / 5 MB), well within a single ListParts page.
    const listed = await this.client.send(new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
    const parts = (listed.Parts ?? [])
      .filter((p) => p.PartNumber != null)
      .sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0))
      .map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag }));
    await this.client.send(
      new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
  }
}

let singleton: StorageClient | null = null;

/** The process-wide storage client (materialized lazily). Routes pass this into the store as
 *  `{ storage }`; tests pass an in-memory fake instead. */
export function getStorage(): StorageClient {
  if (!singleton) singleton = new S3StorageClient();
  return singleton;
}

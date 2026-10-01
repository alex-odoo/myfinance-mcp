import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config";

// AES-256-GCM for provider tokens at rest. Format: base64(iv).base64(ct).base64(tag)

function key(): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(config.tokenEncKey)) {
    throw new Error("Server is missing TOKEN_ENC_KEY (64 hex chars); bank connections are disabled until it is set.");
  }
  return Buffer.from(config.tokenEncKey, "hex");
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${ct.toString("base64")}.${cipher.getAuthTag().toString("base64")}`;
}

// encryptToken always writes the full 16-byte GCM tag. Without a pinned length
// GCM also verifies a truncated tag (4 bytes = 2^-32 forgery odds per try).
const TAG_BYTES = 16;

export function decryptToken(enc: string): string {
  const [iv, ct, tag] = enc.split(".");
  if (!iv || !ct || !tag) throw new Error("Stored token is malformed. Reconnect with connect_zenmoney.");
  const tagBuf = Buffer.from(tag, "base64");
  if (tagBuf.length !== TAG_BYTES) throw new Error("Stored token is malformed. Reconnect with connect_zenmoney.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"), { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tagBuf);
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

import { hexToBytes, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const base64url = (bytes: Uint8Array) =>
  base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export class CredentialError extends Error {}
export class EncryptionKeyError extends Error {}

async function encryptionKey(secret: string | undefined) {
  if (!secret || !/^[A-Za-z0-9+/]{43}=$/.test(secret))
    throw new EncryptionKeyError("Signer encryption unavailable");
  const key = Uint8Array.from(atob(secret), (character) =>
    character.charCodeAt(0),
  );
  if (key.length !== 32 || base64(key) !== secret)
    throw new EncryptionKeyError("Signer encryption unavailable");
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function encodePayload(payload: string, min: number, max: number) {
  if (
    payload.length < min ||
    payload.length > max ||
    !/^[A-Za-z0-9_-]+$/.test(payload)
  )
    throw new CredentialError("Invalid credential");
  const bytes = Uint8Array.from(
    atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  if (base64url(bytes) !== payload)
    throw new CredentialError("Invalid credential");
  return bytes;
}

async function encrypt(
  key: CryptoKey,
  purpose: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(purpose),
      tagLength: 128,
    },
    key,
    bytes,
  );
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv);
  result.set(new Uint8Array(encrypted), iv.length);
  return `v1.${base64url(result)}`;
}

async function decrypt(
  key: CryptoKey,
  purpose: string,
  credential: string,
  min: number,
  max: number,
) {
  try {
    if (!credential.startsWith("v1."))
      throw new CredentialError("Invalid credential");
    const bytes = encodePayload(credential.slice(3), min, max);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.slice(0, 12),
          additionalData: encoder.encode(purpose),
          tagLength: 128,
        },
        key,
        bytes.slice(12),
      ),
    );
  } catch {
    throw new CredentialError("Invalid credential");
  }
}

const signerPurpose = "yld-mcp/signer/v1";
const authorizationPurpose = "yld-mcp/execution-authorization/v1";

export async function createSigner(secret: string | undefined) {
  const key = await encryptionKey(secret);
  const privateKey = generatePrivateKey();
  return {
    address: privateKeyToAccount(privateKey).address,
    secret: await encrypt(
      key,
      signerPurpose,
      Uint8Array.from(hexToBytes(privateKey)),
    ),
  };
}

export async function readSigner(
  secret: string | undefined,
  credential: string,
) {
  const key = await encryptionKey(secret);
  const privateKey = await decrypt(key, signerPurpose, credential, 80, 80);
  if (privateKey.length !== 32) throw new CredentialError("Invalid credential");
  try {
    return privateKeyToAccount(toHex(privateKey));
  } catch {
    throw new CredentialError("Invalid credential");
  }
}

export async function sealAuthorization(secret: string, state: object) {
  return encrypt(
    await encryptionKey(secret),
    authorizationPurpose,
    encoder.encode(JSON.stringify(state)),
  );
}

export async function readAuthorization(
  secret: string,
  state: string,
): Promise<unknown> {
  return JSON.parse(
    decoder.decode(
      await decrypt(
        await encryptionKey(secret),
        authorizationPurpose,
        state,
        40,
        1500,
      ),
    ),
  );
}

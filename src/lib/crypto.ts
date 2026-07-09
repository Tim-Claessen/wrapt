// AES-GCM encryption for refresh tokens at rest (SDD §5 Security).
// TOKEN_ENC_KEY is a base64-encoded 32-byte key, generated once and held as a Worker secret — never in the client bundle.

const IV_BYTES = 12;

async function importKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64(base64Key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Output format: "v1." + base64(iv) + "." + base64(ciphertext+tag). The v1 prefix lets a future key
// rotation introduce a v2 scheme that coexists with existing v1 values, instead of forcing a
// big-bang re-encrypt of every stored token.
export async function encryptToken(plaintext: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptToken(encrypted: string, keyBase64: string): Promise<string> {
  // Versioned format is `v1.<base64 iv>.<base64 ciphertext>`. Legacy values are unprefixed
  // `<base64 iv>.<base64 ciphertext>` and are treated as v1 — same AES-GCM scheme, same key — so
  // tokens stored before versioning keep decrypting with no migration.
  const parts = encrypted.split('.');
  const [ivPart, dataPart] = parts[0] === 'v1' ? parts.slice(1) : parts;
  if (!ivPart || !dataPart) throw new Error('Malformed encrypted token');
  const key = await importKey(keyBase64);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivPart) },
    key,
    fromBase64(dataPart),
  );
  return new TextDecoder().decode(plaintext);
}

const { createPublicKey } = require("crypto");
const { importSPKI, jwtVerify } = require("jose");

const MAX_TOKEN_LIFETIME_SECONDS = 5 * 60;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

async function verifySocketToken(token) {
  if (token.length > 8192) throw new Error("Unauthorized");

  const publicKeyPem = process.env.SOCKET_TOKEN_PUBLIC_KEY?.replace(/\\n/g, "\n");
  const issuer = process.env.SOCKET_TOKEN_ISSUER?.trim();
  const audience = process.env.SOCKET_TOKEN_AUDIENCE?.trim();
  if (!publicKeyPem || !issuer || !audience) {
    throw new Error("Socket token verification is not configured");
  }

  const publicKey = createPublicKey(publicKeyPem);
  if (
    publicKey.asymmetricKeyType !== "rsa" ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new Error("Invalid socket verification key");
  }

  const verificationKey = await importSPKI(publicKeyPem, "RS256");
  const { payload, protectedHeader } = await jwtVerify(token, verificationKey, {
    algorithms: ["RS256"],
    issuer,
    audience,
  });

  const now = Math.floor(Date.now() / 1000);
  if (
    protectedHeader.typ !== "JWT" ||
    Object.keys(protectedHeader).some((key) => !["alg", "typ"].includes(key)) ||
    typeof payload.sub !== "string" ||
    !OBJECT_ID_PATTERN.test(payload.sub) ||
    typeof payload.iat !== "number" ||
    !Number.isInteger(payload.iat) ||
    typeof payload.exp !== "number" ||
    !Number.isInteger(payload.exp) ||
    typeof payload.jti !== "string" ||
    payload.jti.length === 0 ||
    payload.jti.length > 128 ||
    payload.iat > now ||
    payload.aud !== audience ||
    payload.exp <= now ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error("Invalid socket token claims");
  }

  return payload.sub.toLowerCase();
}

module.exports = { verifySocketToken };
# Socket security integration

This repository expects Habitix to issue a short-lived socket token after verifying its NextAuth session. No credential values belong in source control, browser bundles, or `NEXT_PUBLIC_*` variables.

## Socket token verification

Set these server-side values in the socket service and the matching issuer-side values in Habitix:

- `SOCKET_TOKEN_PUBLIC_KEY`: RSA SubjectPublicKeyInfo public key PEM corresponding to Habitix's private signing key. This service never needs the private key.
- `SOCKET_TOKEN_ISSUER`: exact JWT issuer string configured by Habitix.
- `SOCKET_TOKEN_AUDIENCE`: exact JWT audience string configured by Habitix.

The expected token is a compact JWT/JWS signed with `RS256`, containing `sub` (24-character MongoDB user ID), `iss`, `aud` (string), integer `iat` and `exp`, and non-empty `jti`. The public key must be RSA with at least 2048-bit modulus. Tokens may live for no more than five minutes. Connections without a valid token are rejected. The client must send it as `auth.token`; `auth.userId` is not trusted.

PEM values may use literal newlines or escaped `\\n` sequences. Do not place signing keys in this repository or in a client-readable environment variable.

## Habitix authorization API (implemented contract)

Configure these values only on the socket server:

- `HABITIX_INTERNAL_API_BASE_URL`: Habitix server origin. HTTPS is required except for loopback development.
- `SOCKET_INTERNAL_API_TOKEN`: dedicated high-entropy bearer credential, at least 32 bytes, separate from all JWT keys and NextAuth secrets. Send only in the server-to-server `Authorization` header over HTTPS.

For each `sendMessage` event, the socket server calls `POST /api/internal/socket/authorize` with the persisted message ID; for `typing`, it omits `messageId`. Example message request:

```json
{ "action": "sendMessage", "chatId": "<chat id>", "userId": "<verified token subject>", "messageId": "<persisted message id>", "text": "<persisted message text>" }
```

The expected successful response is:

```json
{ "authorized": true, "action": "sendMessage", "chatId": "<verified chat id>", "senderId": "<verified sender id>", "recipientId": "<other chat participant id>", "messageId": "<verified message id>", "textMatches": true }
```

Habitix implements this response contract. For `sendMessage`, it also verifies that `messageId` and the supplied text match a message persisted by the claimed sender in the specified chat; `textMatches: true` confirms the comparison without returning the text in the response. The Socket.IO client checks response fields before delivery. Any timeout, non-success response, malformed result, or mismatch denies delivery. Client-provided `receiverId` is ignored, and unverified message text is never relayed. The API authenticates the dedicated bearer credential, verifies membership, and derives the recipient from the stored chat.

Habitix authorization preserves access to eligible two-participant legacy chats without request metadata. For request-linked chats, it authorizes access only when the linked request is accepted, its chatId matches the requested chat, its participant IDs match the chat participants, and its acceptance links are complete. Pending, declined, missing, malformed, or inconsistent request links are denied. The same rule applies to REST history and message persistence and to socket sendMessage and typing authorization.

## Client integration status

The current Habitix client obtains a short-lived token from `POST /api/socket/token` and sends it as `auth.token`. It emits `typing` with `chatId`, and persists messages through the REST API before emitting `sendMessage` with `chatId`, `messageId`, and the persisted text. Habitix verifies the message ID and text; the socket server relays them only after authorization. The Socket.IO server derives sender identity from the verified token and the recipient from Habitix's authorization response.
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const AUTHORIZATION_PATH = "/api/internal/socket/authorize";
const REQUEST_TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 2048;

class HabitixAuthorizationError extends Error {
  constructor(outcome) {
    super(outcome);
    this.name = "HabitixAuthorizationError";
    this.outcome = outcome;
  }
}

function normalizeId(value) {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function getAuthorizationEndpoint() {
  const baseUrl = process.env.HABITIX_INTERNAL_API_BASE_URL?.trim();
  if (!baseUrl) throw new Error("Socket authorization is not configured");

  const url = new URL(baseUrl);
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(isLoopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Invalid Habitix API base URL");
  }

  return new URL(AUTHORIZATION_PATH, url);
}

async function readLimitedBody(response) {
  if (!response.body) throw new Error("Invalid authorization response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Authorization response too large");
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function authorizeSocketAction({ action, chatId, userId, messageId, text }) {
  const startedAt = Date.now();
  let category = "unexpected_internal_error";
  let outcome = "authorization_unavailable";
  let httpStatus = null;
  let timeout;
  let timedOut = false;

  try {
    const normalizedChatId = normalizeId(chatId);
    const normalizedUserId = normalizeId(userId);
    const normalizedMessageId = action === "sendMessage" ? normalizeId(messageId) : null;
    if (
      !normalizedChatId ||
      !normalizedUserId ||
      !["sendMessage", "typing"].includes(action) ||
      (action === "sendMessage" &&
        (!normalizedMessageId || typeof text !== "string" || !text.trim())) ||
      (action === "typing" && (messageId !== undefined || text !== undefined))
    ) {
      throw new Error("Invalid authorization input");
    }

    const credential = process.env.SOCKET_INTERNAL_API_TOKEN;
    if (!credential || Buffer.byteLength(credential) < 32) {
      category = "configuration";
      throw new Error("Authorization credential is not configured");
    }

    let endpoint;
    try {
      endpoint = getAuthorizationEndpoint();
    } catch (error) {
      category = "configuration";
      throw error;
    }

    const controller = new AbortController();
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          action,
          chatId: normalizedChatId,
          userId: normalizedUserId,
          ...(normalizedMessageId ? { messageId: normalizedMessageId, text } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      category = timedOut ? "timeout" : "network_tls";
      throw error;
    }

    httpStatus = response.status;
    if (!response.ok) {
      category = "http_response";
      if (response.status === 403 || response.status === 404) {
        outcome = "authorization_denied";
      }
      throw new Error("Authorization endpoint returned a non-success status");
    }

    let body;
    try {
      body = await readLimitedBody(response);
    } catch (error) {
      if (timedOut) {
        category = "timeout";
      } else if (
        error?.message === "Invalid authorization response" ||
        error?.message === "Authorization response too large"
      ) {
        category = "response_contract_mismatch";
      } else {
        category = "network_tls";
      }
      throw error;
    }

    let result;
    try {
      result = JSON.parse(body);
    } catch (error) {
      category = "invalid_json";
      throw error;
    }

    const authorizedChatId = normalizeId(result?.chatId);
    const senderId = normalizeId(result?.senderId);
    const recipientId = normalizeId(result?.recipientId);
    const authorizedMessageId = action === "sendMessage"
      ? normalizeId(result?.messageId)
      : null;
    if (
      result?.authorized !== true ||
      result?.action !== action ||
      authorizedChatId !== normalizedChatId ||
      senderId !== normalizedUserId ||
      !recipientId ||
      recipientId === senderId ||
      (action === "sendMessage" &&
        (authorizedMessageId !== normalizedMessageId || result?.textMatches !== true))
    ) {
      category = "response_contract_mismatch";
      throw new Error("Authorization response did not match the contract");
    }

    return {
      chatId: authorizedChatId,
      senderId,
      recipientId,
      ...(action === "sendMessage"
        ? { messageId: authorizedMessageId, text }
        : {}),
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    console.warn("[socket] Habitix authorization failure", {
      category,
      httpStatus,
      elapsedMs,
    });
    const failure = new HabitixAuthorizationError(outcome);
    failure.category = category;
    failure.httpStatus = httpStatus;
    failure.elapsedMs = elapsedMs;
    throw failure;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
module.exports = { authorizeSocketAction };
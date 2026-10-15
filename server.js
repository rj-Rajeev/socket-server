const { createServer } = require("http");
const { Server } = require("socket.io");
const { verifySocketToken } = require("./socket-token");
const { authorizeSocketAction } = require("./habitix-authorization");
require("dotenv").config();
const server = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Server is working!");
  }
});

const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "https://www.habitix.in"],
  },
});

const onlineUsers = new Map();

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string") throw new Error("Unauthorized");
    socket.data.userId = await verifySocketToken(token);
    next();
  } catch {
    console.warn("[socket] connection rejected", { outcome: "authentication_failed" });
    next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  const userId = socket.data.userId;
  socket.join(userId);
  onlineUsers.set(userId, socket.id);
  console.info("[socket] connection", { outcome: "connected" });
  io.emit("onlineUsers", Array.from(onlineUsers.keys()));

  socket.on("typing", async (data) => {
    try {
      if (!data || typeof data.chatId !== "string") return;
      const authorization = await authorizeSocketAction({
        action: "typing",
        chatId: data.chatId,
        userId,
      });
      io.to(authorization.recipientId).emit("typing", {
        senderId: authorization.senderId,
      });
    } catch {
      // Deny silently; the legacy receiverId-only payload is not authorized.
    }
  });

  socket.on("sendMessage", async (data, acknowledge) => {
    let acknowledged = false;
    const acknowledgeOnce = (result) => {
      if (acknowledged) return;
      acknowledged = true;
      if (typeof acknowledge === "function") acknowledge(result);
    };

    try {
      if (
        !data ||
        typeof data.chatId !== "string" ||
        typeof data.messageId !== "string" ||
        typeof data.text !== "string" ||
        !data.text.trim()
      ) {
        console.warn("[socket] sendMessage", { outcome: "invalid_message" });
        acknowledgeOnce({ status: "invalid_message" });
        return;
      }

      let authorization;
      try {
        authorization = await authorizeSocketAction({
          action: "sendMessage",
          chatId: data.chatId,
          userId,
          messageId: data.messageId,
          text: data.text,
        });
      } catch (error) {
        const outcome = error?.outcome === "authorization_denied"
          ? "authorization_denied"
          : "authorization_unavailable";
        acknowledgeOnce({ status: outcome });
        return;
      }

      try {
        io.to(authorization.recipientId).emit("receiveMessage", {
          chatId: authorization.chatId,
          messageId: authorization.messageId,
          text: authorization.text,
          senderId: authorization.senderId,
        });
        console.info("[socket] sendMessage emission", { outcome: "emitted" });
        acknowledgeOnce({ status: "emitted" });
      } catch {
        console.error("[socket] sendMessage emission", { outcome: "emission_failed" });
        acknowledgeOnce({ status: "emission_failed" });
      }
    } catch {
      console.error("[socket] sendMessage", { outcome: "server_error" });
      acknowledgeOnce({ status: "authorization_unavailable" });
    }
  });

  socket.on("disconnect", () => {
    onlineUsers.delete(userId);
    console.info("[socket] disconnection", { outcome: "disconnected" });
    io.emit("onlineUsers", Array.from(onlineUsers.keys()));
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log("Socket server running on port", PORT);
});
const { createServer } = require("http");
const { Server } = require("socket.io");

// const server = createServer();

const server = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Server is working!");
  }
});


const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://www.habitix.in",
    ],
  },
});

const onlineUsers = new Map();

io.on("connection", (socket) => {
  const userId = socket.handshake.auth.userId;

  if (!userId) return;

  socket.join(userId);
  onlineUsers.set(userId, socket.id);

  console.log("User connected:", userId);

  io.emit("onlineUsers", Array.from(onlineUsers.keys()));

  socket.on("typing", ({ receiverId }) => {
    io.to(receiverId).emit("typing", { senderId: userId });
  });

  socket.on("sendMessage", ({ chatId, text, receiverId }) => {
    io.to(receiverId).emit("receiveMessage", {
      chatId,
      text,
      senderId: userId,
    });
  });

  socket.on("disconnect", () => {
    onlineUsers.delete(userId);
    console.log("User disconnected");

    io.emit("onlineUsers", Array.from(onlineUsers.keys()));
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Socket server running on port", PORT);
});
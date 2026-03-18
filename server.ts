import express from "express";
import { Server } from "socket.io";
import http from "http";
import path from "path";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

type Player = { id: string; name: string };
type Room = {
  id: string;
  players: Player[];
  state: "lobby" | "playing" | "reveal";
  turn: number;
};

const rooms: Record<string, Room> = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("createRoom", ({ name }) => {
    const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[roomId] = { id: roomId, players: [{ id: socket.id, name }], state: "lobby", turn: 0 };
    socket.join(roomId);
    socket.emit("roomCreated", roomId);
    io.to(roomId).emit("roomUpdate", rooms[roomId]);
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    const room = rooms[roomId];
    if (room && room.state === "lobby") {
      room.players.push({ id: socket.id, name });
      socket.join(roomId);
      io.to(roomId).emit("roomUpdate", room);
    } else {
      socket.emit("error", "Room not found or game started");
    }
  });

  socket.on("startGame", (roomId) => {
    const room = rooms[roomId];
    if (room) {
      room.state = "playing";
      io.to(roomId).emit("gameStarted");
      // Give initial prompts (placeholder logic)
      room.players.forEach((p, i) => {
        io.to(p.id).emit("turnPrompt", { type: "draw", word: "A cute cat" });
      });
    }
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
      io.to(roomId).emit("roomUpdate", rooms[roomId]);
    }
  });
});

app.use(express.static(path.join(__dirname, "client/dist")));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

import { io } from "socket.io-client";

const socket = io(window.location.hostname === "localhost" ? "http://localhost:3001" : "/");

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
    <h1>Drawphone Remake</h1>
    <div id="lobby">
      <input type="text" id="name" placeholder="Your Name" />
      <button id="createBtn">Create Room</button>
      <br/><br/>
      <input type="text" id="roomCode" placeholder="Room Code" />
      <button id="joinBtn">Join Room</button>
    </div>
    <div id="room" style="display: none;">
      <h2 id="roomTitle"></h2>
      <ul id="playersList"></ul>
      <button id="startBtn">Start Game</button>
    </div>
    <div id="game" style="display: none;">
      <h2 id="promptText"></h2>
      <canvas id="drawCanvas" width="300" height="400" style="border:1px solid #000; background:white; touch-action:none;"></canvas>
      <br/>
      <input type="color" id="colorPicker" value="#000000" />
      <input type="range" id="sizePicker" min="1" max="20" value="3" />
      <button id="eraserBtn">Eraser</button>
      <button id="clearBtn">Clear</button>
      <button id="submitDrawBtn">Done</button>
    </div>
  </div>
`;

// Lobby Logic
const lobbyDiv = document.getElementById("lobby")!;
const roomDiv = document.getElementById("room")!;
const gameDiv = document.getElementById("game")!;

document.getElementById("createBtn")!.addEventListener("click", () => {
  const name = (document.getElementById("name") as HTMLInputElement).value;
  socket.emit("createRoom", { name });
});

document.getElementById("joinBtn")!.addEventListener("click", () => {
  const name = (document.getElementById("name") as HTMLInputElement).value;
  const roomId = (document.getElementById("roomCode") as HTMLInputElement).value;
  socket.emit("joinRoom", { roomId, name });
});

let currentRoom = "";

socket.on("roomCreated", (roomId) => { currentRoom = roomId; });
socket.on("roomUpdate", (room) => {
  lobbyDiv.style.display = "none";
  roomDiv.style.display = "block";
  document.getElementById("roomTitle")!.innerText = "Room: " + room.id;
  document.getElementById("playersList")!.innerHTML = room.players.map((p: any) => \`<li>\${p.name}</li>\`).join("");
});

document.getElementById("startBtn")!.addEventListener("click", () => {
  socket.emit("startGame", currentRoom);
});

socket.on("gameStarted", () => {
  roomDiv.style.display = "none";
  gameDiv.style.display = "block";
});

// Canvas Logic
const canvas = document.getElementById("drawCanvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let isDrawing = false;
let color = "#000000";
let size = 3;

document.getElementById("colorPicker")!.addEventListener("change", (e) => color = (e.target as HTMLInputElement).value);
document.getElementById("sizePicker")!.addEventListener("change", (e) => size = parseInt((e.target as HTMLInputElement).value));
document.getElementById("eraserBtn")!.addEventListener("click", () => color = "#ffffff");
document.getElementById("clearBtn")!.addEventListener("click", () => { ctx.clearRect(0, 0, canvas.width, canvas.height); });

const startDraw = (e: MouseEvent | TouchEvent) => {
  isDrawing = true;
  draw(e);
};

const stopDraw = () => {
  isDrawing = false;
  ctx.beginPath();
};

const draw = (e: MouseEvent | TouchEvent) => {
  if (!isDrawing) return;
  e.preventDefault();
  
  const rect = canvas.getBoundingClientRect();
  const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
  const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
  
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y);
};

canvas.addEventListener("mousedown", startDraw);
canvas.addEventListener("mouseup", stopDraw);
canvas.addEventListener("mousemove", draw);
canvas.addEventListener("touchstart", startDraw);
canvas.addEventListener("touchend", stopDraw);
canvas.addEventListener("touchmove", draw);

socket.on("turnPrompt", ({ type, word }) => {
  document.getElementById("promptText")!.innerText = "Draw: " + word;
});

document.getElementById("submitDrawBtn")!.addEventListener("click", () => {
  const data = canvas.toDataURL();
  socket.emit("submitTurn", { roomId: currentRoom, data });
  alert("Submitted! Waiting for others...");
});

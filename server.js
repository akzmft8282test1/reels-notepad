require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "reels_secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 로그인 API
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const { data: user, error } = await supabase
    .from("allowed_users")
    .select("*")
    .eq("username", username)
    .single();

  if (error || !user)
    return res
      .status(401)
      .json({ success: false, message: "등록되지 않은 계정입니다." });

  let isValidPassword =
    user.password && user.password.startsWith("$2")
      ? await bcrypt.compare(password, user.password)
      : password === user.password;

  if (!isValidPassword)
    return res
      .status(401)
      .json({ success: false, message: "비밀번호가 올바르지 않습니다." });

  req.session.user = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role || "Member",
  };
  res.json({ success: true, user: req.session.user });
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get("/api/boards", async (req, res) => {
  const { data, error } = await supabase
    .from("boards")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/memos/:boardId", async (req, res) => {
  const { boardId } = req.params;
  const { data, error } = await supabase
    .from("memos")
    .select("*")
    .eq("board_id", boardId)
    .eq("is_deleted", false)
    .order("updated_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 드로잉 데이터 조회 (Fabric.js SVG 기반)
app.get("/api/drawings/:boardId", async (req, res) => {
  const { boardId } = req.params;
  const { data, error } = await supabase
    .from("canvas_drawings")
    .select("*")
    .eq("board_id", boardId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 음성 채널 목록 조회
app.get("/api/voice-channels/:boardId", async (req, res) => {
  const { boardId } = req.params;
  const { data, error } = await supabase
    .from("voice_channels")
    .select("*")
    .eq("board_id", boardId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 음성 채널 생성
app.post("/api/voice-channels", async (req, res) => {
  const { board_id, name, max_users } = req.body;
  const { data, error } = await supabase
    .from("voice_channels")
    .insert([{ board_id, name, max_users: parseInt(max_users) || 4 }])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  io.to(board_id).emit("voice:channel_created", data[0]);
  res.json(data[0]);
});

// --- Socket.io 실시간 협업 & WebRTC 음성 연결 ---
const activeUsers = new Map();
const voiceRooms = new Map(); // roomId -> Set of socketIds

io.on("connection", (socket) => {
  const req = socket.request;
  const user = req.session?.user;

  if (user) {
    activeUsers.set(socket.id, {
      id: socket.id,
      username: user.username,
      name: user.name,
      role: user.role,
      boardId: null,
    });
    io.emit("presence:update", Array.from(activeUsers.values()));
  }

  socket.on("board:join", (boardId) => {
    socket.join(boardId);
    if (activeUsers.has(socket.id)) {
      activeUsers.get(socket.id).boardId = boardId;
      io.emit("presence:update", Array.from(activeUsers.values()));
    }
  });

  socket.on("cursor:move", (pos) => {
    const userInfo = activeUsers.get(socket.id);
    if (userInfo && userInfo.boardId) {
      socket.to(userInfo.boardId).emit("cursor:update", {
        socketId: socket.id,
        name: userInfo.name,
        x: pos.x,
        y: pos.y,
      });
    }
  });

  // ⚡ Fabric.js 기반 렉 없는 SVG 드로잉 동기화
  socket.on("drawing:path", async ({ boardId, svgPath }) => {
    if (user?.role === "Viewer") return;
    socket.to(boardId).emit("drawing:path", { svgPath });

    await supabase.from("canvas_drawings").insert([
      {
        board_id: boardId,
        path_data: svgPath,
        author: user?.name,
      },
    ]);
  });

  socket.on("drawing:clear", async (boardId) => {
    if (user?.role === "Viewer") return;
    await supabase.from("canvas_drawings").delete().eq("board_id", boardId);
    io.to(boardId).emit("drawing:cleared");
  });

  socket.on("memo:move", async ({ memoId, boardId, pos_x, pos_y }) => {
    if (user?.role === "Viewer") return;
    await supabase.from("memos").update({ pos_x, pos_y }).eq("id", memoId);
    socket.to(boardId).emit("memo:moved", { memoId, pos_x, pos_y });
  });

  socket.on("memo:save", async (memoData) => {
    if (user?.role === "Viewer") return;
    memoData.last_edited_by = user?.name || "익명";
    memoData.updated_at = new Date().toISOString();

    let result;
    if (memoData.id) {
      const { data } = await supabase
        .from("memos")
        .update(memoData)
        .eq("id", memoData.id)
        .select();
      result = data ? data[0] : null;
    } else {
      const { data } = await supabase.from("memos").insert([memoData]).select();
      result = data ? data[0] : null;
    }

    if (result) {
      io.to(result.board_id).emit("memo:updated", result);
    }
  });

  // 🎙️ 디스코드형 음성 채널 WebRTC 시그널링
  socket.on("voice:join", ({ roomId, maxUsers }) => {
    if (!voiceRooms.has(roomId)) {
      voiceRooms.set(roomId, new Map());
    }

    const room = voiceRooms.get(roomId);
    if (room.size >= maxUsers) {
      socket.emit("voice:full");
      return;
    }

    room.set(socket.id, user?.name || "익명");
    socket.join(`voice-${roomId}`);

    const usersInRoom = Array.from(room.entries()).map(([id, name]) => ({
      id,
      name,
    }));
    io.to(`voice-${roomId}`).emit("voice:users", usersInRoom);
  });

  socket.on("voice:signal", ({ targetId, signal }) => {
    io.to(targetId).emit("voice:signal", { senderId: socket.id, signal });
  });

  socket.on("voice:leave", ({ roomId }) => {
    if (voiceRooms.has(roomId)) {
      const room = voiceRooms.get(roomId);
      room.delete(socket.id);
      socket.leave(`voice-${roomId}`);

      const usersInRoom = Array.from(room.entries()).map(([id, name]) => ({
        id,
        name,
      }));
      io.to(`voice-${roomId}`).emit("voice:users", usersInRoom);
    }
  });

  socket.on("disconnect", () => {
    io.emit("cursor:remove", socket.id);
    activeUsers.delete(socket.id);

    // 음성 방 퇴장 처리
    voiceRooms.forEach((room, roomId) => {
      if (room.has(socket.id)) {
        room.delete(socket.id);
        const usersInRoom = Array.from(room.entries()).map(([id, name]) => ({
          id,
          name,
        }));
        io.to(`voice-${roomId}`).emit("voice:users", usersInRoom);
      }
    });

    io.emit("presence:update", Array.from(activeUsers.values()));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(
    `🎬 렉 최적화 Fabric.js & 음성 피그마 캔버스: http://localhost:${PORT}`,
  );
});

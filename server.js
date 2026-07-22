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

// 연결선 조회 API
app.get("/api/connections/:boardId", async (req, res) => {
  const { boardId } = req.params;
  const { data, error } = await supabase
    .from("memo_connections")
    .select("*")
    .eq("board_id", boardId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/drawings/:boardId", async (req, res) => {
  const { boardId } = req.params;
  const { data, error } = await supabase
    .from("canvas_drawings")
    .select("*")
    .eq("board_id", boardId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/voice-channels/:boardId", async (req, res) => {
  const { boardId } = req.params;
  const { data, error } = await supabase
    .from("voice_channels")
    .select("*")
    .eq("board_id", boardId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

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

// --- Socket.io 실시간 협업 ---
const activeUsers = new Map();
const voiceRooms = new Map();

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

  // 1번 기능: 화살표 연결선 저장 및 동기화
  socket.on("connection:create", async ({ boardId, fromId, toId }) => {
    if (user?.role === "Viewer") return;
    const { data } = await supabase
      .from("memo_connections")
      .insert([{ board_id: boardId, from_memo_id: fromId, to_memo_id: toId }])
      .select();
    if (data) {
      io.to(boardId).emit("connection:created", data[0]);
    }
  });

  // 5번 기능: 카드 리사이즈(크기 변경) 동기화
  socket.on("memo:resize", async ({ memoId, boardId, width, height }) => {
    if (user?.role === "Viewer") return;
    await supabase.from("memos").update({ width, height }).eq("id", memoId);
    socket.to(boardId).emit("memo:resized", { memoId, width, height });
  });

  // 8번 기능: 카드 잠금 상태 동기화
  socket.on("memo:lock", async ({ memoId, boardId, is_locked }) => {
    if (user?.role === "Viewer") return;
    await supabase.from("memos").update({ is_locked }).eq("id", memoId);
    io.to(boardId).emit("memo:locked", { memoId, is_locked });
  });

  socket.on("drawing:path", async ({ boardId, svgPath }) => {
    if (user?.role === "Viewer") return;
    socket.to(boardId).emit("drawing:path", { svgPath });
    await supabase
      .from("canvas_drawings")
      .insert([{ board_id: boardId, path_data: svgPath, author: user?.name }]);
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

  socket.on("disconnect", () => {
    io.emit("cursor:remove", socket.id);
    activeUsers.delete(socket.id);
    io.emit("presence:update", Array.from(activeUsers.values()));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 10대 기능 풀세트 릴스 캔버스: http://localhost:${PORT}`);
});

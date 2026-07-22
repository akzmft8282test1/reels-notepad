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

async function logAction(username, action, details) {
  try {
    await supabase.from("audit_logs").insert([{ username, action, details }]);
  } catch (e) {
    console.error("Log error:", e);
  }
}

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

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
  await logAction(user.username, "LOGIN", "로그인 성공");
  res.json({ success: true, user: req.session.user });
});

app.post("/api/admin/users", async (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password)
    return res
      .status(400)
      .json({ success: false, message: "모든 항목을 입력해주세요." });

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from("allowed_users")
      .insert([
        { name, username, password: hashedPassword, role: role || "Member" },
      ])
      .select();

    if (error)
      return res.status(500).json({ success: false, message: error.message });
    res.json({ success: true, user: data[0] });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: "서버 오류가 발생했습니다." });
  }
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

// 기존 드로잉 데이터 불러오기
app.get("/api/drawings/:boardId", async (req, res) => {
  const { boardId } = req.params;
  const { data, error } = await supabase
    .from("canvas_drawings")
    .select("*")
    .eq("board_id", boardId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/trash/:boardId", async (req, res) => {
  const { boardId } = req.params;
  const sixtyDaysAgo = new Date(
    Date.now() - 60 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await supabase
    .from("memos")
    .select("*")
    .eq("board_id", boardId)
    .eq("is_deleted", true)
    .gte("deleted_at", sixtyDaysAgo);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/memos/restore", async (req, res) => {
  if (!req.session.user || req.session.user.role === "Viewer")
    return res.status(403).json({ message: "권한이 없습니다." });
  const { memoId } = req.body;
  const { data, error } = await supabase
    .from("memos")
    .update({ is_deleted: false, deleted_at: null })
    .eq("id", memoId)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  io.to(data[0].board_id).emit("memo:updated", data[0]);
  res.json({ success: true });
});

app.get("/api/comments/:memoId", async (req, res) => {
  const { memoId } = req.params;
  const { data, error } = await supabase
    .from("comments")
    .select("*")
    .eq("memo_id", memoId)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Socket.io 실시간 통신 ---
const activeUsers = new Map();

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

  // 손글씨/그림 드로잉 실시간 방송 및 DB 저장
  socket.on("drawing:stroke", async (strokeData) => {
    if (user?.role === "Viewer") return;

    socket.to(strokeData.boardId).emit("drawing:stroke", strokeData);

    await supabase.from("canvas_drawings").insert([
      {
        board_id: strokeData.boardId,
        path_data: JSON.stringify(strokeData.points),
        color: strokeData.color,
        width: strokeData.width,
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

  socket.on("memo:delete", async ({ memoId, boardId }) => {
    if (user?.role === "Viewer") return;
    await supabase
      .from("memos")
      .update({ is_deleted: true, deleted_at: new Date().toISOString() })
      .eq("id", memoId);
    io.to(boardId).emit("memo:updated", { id: memoId, is_deleted: true });
  });

  socket.on("comment:add", async ({ memoId, boardId, content }) => {
    if (!content || user?.role === "Viewer") return;
    const { data: comment } = await supabase
      .from("comments")
      .insert([{ memo_id: memoId, author: user?.name || "익명", content }])
      .select();
    if (comment) {
      io.to(boardId).emit("comment:added", { memoId, comment: comment[0] });
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
  console.log(`🎬 자유 드로잉 피그마 캔버스 실행 중: http://localhost:${PORT}`);
});

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Supabase 클라이언트 초기화
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// 미들웨어
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

// Socket.io 세션 공유
io.engine.use(sessionMiddleware);

// --- API 라우트 ---

// 1. 로그인 (DB allowed_users 기반)
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const { data: user, error } = await supabase
    .from("allowed_users")
    .select("*")
    .eq("username", username)
    .single();

  if (error || !user) {
    return res
      .status(401)
      .json({ success: false, message: "등록되지 않은 계정입니다." });
  }

  // 비밀번호 검증 (bcrypt 비교 또는 평문 호환)
  const isValidPassword = await bcrypt
    .compare(password, user.password)
    .catch(() => password === user.password);

  if (!isValidPassword) {
    return res
      .status(401)
      .json({ success: false, message: "비밀번호가 올바르지 않습니다." });
  }

  req.session.user = { id: user.id, username: user.username, name: user.name };
  res.json({ success: true, user: req.session.user });
});

// 2. 현재 로그인 정보 확인
app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user });
});

// 3. 로그아웃
app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// 4. 게시판 목록 불러오기
app.get("/api/boards", async (req, res) => {
  const { data, error } = await supabase
    .from("boards")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 5. 새 게시판 생성
app.post("/api/boards", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ message: "권한이 없습니다." });
  const { name, description } = req.body;
  const { data, error } = await supabase
    .from("boards")
    .insert([{ name, description }])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// 6. 메모 목록 불러오기
app.get("/api/memos/:boardId", async (req, res) => {
  const { boardId } = req.params;
  const { data, error } = await supabase
    .from("memos")
    .select("*")
    .eq("board_id", boardId)
    .order("updated_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Socket.io 실시간 협업 통신 ---
const activeUsers = new Map();

io.on("connection", (socket) => {
  const req = socket.request;
  const user = req.session?.user;

  if (user) {
    activeUsers.set(socket.id, {
      username: user.username,
      name: user.name,
      boardId: null,
    });
    io.emit("presence:update", Array.from(activeUsers.values()));
  }

  // 게시판 입장
  socket.on("board:join", (boardId) => {
    socket.join(boardId);
    if (activeUsers.has(socket.id)) {
      activeUsers.get(socket.id).boardId = boardId;
      io.emit("presence:update", Array.from(activeUsers.values()));
    }
  });

  // 실시간 타이핑 신호 전송
  socket.on("memo:typing", ({ boardId, memoId, field }) => {
    socket.to(boardId).emit("memo:typing", { memoId, user: user?.name, field });
  });

  // 메모 신규 생성 / 수정 방송
  socket.on("memo:save", async (memoData) => {
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

  // 좋아요 클릭
  socket.on("memo:like", async ({ memoId, boardId }) => {
    const { data: memo } = await supabase
      .from("memos")
      .select("likes")
      .eq("id", memoId)
      .single();
    if (memo) {
      const newLikes = (memo.likes || 0) + 1;
      await supabase.from("memos").update({ likes: newLikes }).eq("id", memoId);
      io.to(boardId).emit("memo:liked", { memoId, likes: newLikes });
    }
  });

  socket.on("disconnect", () => {
    activeUsers.delete(socket.id);
    io.emit("presence:update", Array.from(activeUsers.values()));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 릴스 노트패드 서버 실행 중: http://localhost:${PORT}`);
});

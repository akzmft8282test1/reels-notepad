require("dotenv").config(); //[cite: 2]
const express = require("express"); //[cite: 2]
const http = require("http"); //[cite: 2]
const { Server } = require("socket.io"); //[cite: 2]
const session = require("express-session"); //[cite: 2]
const bcrypt = require("bcryptjs"); //[cite: 2]
const { createClient } = require("@supabase/supabase-js"); //[cite: 2]
const path = require("path");

const app = express(); //[cite: 2]
const server = http.createServer(app); //[cite: 2]
const io = new Server(server); //[cite: 2]

// Supabase 클라이언트 초기화[cite: 2]
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
); //[cite: 2]

// 미들웨어[cite: 2]
app.use(express.json()); //[cite: 2]
app.use(express.urlencoded({ extended: true })); //[cite: 2]
app.use(express.static("public")); //[cite: 2]

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "reels_secret", //[cite: 2]
  resave: false, //[cite: 2]
  saveUninitialized: false, //[cite: 2]
  cookie: { maxAge: 24 * 60 * 60 * 1000 }, //[cite: 2]
});

app.use(sessionMiddleware); //[cite: 2]

// Socket.io 세션 공유[cite: 2]
io.engine.use(sessionMiddleware); //[cite: 2]

// --- 라우트 ---

// /admin 접속 시 index.html 서빙
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 1. 로그인 (DB allowed_users 기반)[cite: 2]
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body; //[cite: 2]

  const { data: user, error } = await supabase
    .from("allowed_users")
    .select("*")
    .eq("username", username)
    .single(); //[cite: 2]

  if (error || !user) {
    return res
      .status(401)
      .json({ success: false, message: "등록되지 않은 계정입니다." }); //[cite: 2]
  }

  // 비밀번호 검증 (bcrypt 비교 및 평문 호환)[cite: 2]
  let isValidPassword = false;
  if (user.password && user.password.startsWith("$2")) {
    isValidPassword = await bcrypt.compare(password, user.password);
  } else {
    isValidPassword = password === user.password;
  }

  if (!isValidPassword) {
    return res
      .status(401)
      .json({ success: false, message: "비밀번호가 올바르지 않습니다." }); //[cite: 2]
  }

  req.session.user = { id: user.id, username: user.username, name: user.name }; //[cite: 2]
  res.json({ success: true, user: req.session.user }); //[cite: 2]
});

// 관리자 계정 추가 API (닉네임, 아이디, 비밀번호)
app.post("/api/admin/users", async (req, res) => {
  const { name, username, password } = req.body;

  if (!name || !username || !password) {
    return res
      .status(400)
      .json({ success: false, message: "모든 항목을 입력해주세요." });
  }

  try {
    // 비밀번호 bcrypt 암호화
    const hashedPassword = await bcrypt.hash(password, 10);

    const { data, error } = await supabase
      .from("allowed_users")
      .insert([{ name, username, password: hashedPassword }])
      .select();

    if (error) {
      if (error.code === "23505") {
        // UNIQUE 제약조건 에러
        return res
          .status(400)
          .json({ success: false, message: "이미 존재하는 아이디입니다." });
      }
      return res.status(500).json({ success: false, message: error.message });
    }

    res.json({ success: true, user: data[0] });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: "서버 오류가 발생했습니다." });
  }
});

// 2. 현재 로그인 정보 확인[cite: 2]
app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ loggedIn: false }); //[cite: 2]
  res.json({ loggedIn: true, user: req.session.user }); //[cite: 2]
});

// 3. 로그아웃[cite: 2]
app.post("/api/logout", (req, res) => {
  req.session.destroy(); //[cite: 2]
  res.json({ success: true }); //[cite: 2]
});

// 4. 게시판 목록 불러오기[cite: 2]
app.get("/api/boards", async (req, res) => {
  const { data, error } = await supabase
    .from("boards")
    .select("*")
    .order("created_at", { ascending: true }); //[cite: 2]
  if (error) return res.status(500).json({ error: error.message }); //[cite: 2]
  res.json(data); //[cite: 2]
});

// 5. 새 게시판 생성[cite: 2]
app.post("/api/boards", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ message: "권한이 없습니다." }); //[cite: 2]
  const { name, description } = req.body; //[cite: 2]
  const { data, error } = await supabase
    .from("boards")
    .insert([{ name, description }])
    .select(); //[cite: 2]
  if (error) return res.status(500).json({ error: error.message }); //[cite: 2]
  res.json(data[0]); //[cite: 2]
});

// 6. 메모 목록 불러오기[cite: 2]
app.get("/api/memos/:boardId", async (req, res) => {
  const { boardId } = req.params; //[cite: 2]
  const { data, error } = await supabase
    .from("memos")
    .select("*")
    .eq("board_id", boardId)
    .order("updated_at", { ascending: false }); //[cite: 2]
  if (error) return res.status(500).json({ error: error.message }); //[cite: 2]
  res.json(data); //[cite: 2]
});

// --- Socket.io 실시간 협업 통신 ---[cite: 2]
const activeUsers = new Map(); //[cite: 2]

io.on("connection", (socket) => {
  const req = socket.request; //[cite: 2]
  const user = req.session?.user; //[cite: 2]

  if (user) {
    activeUsers.set(socket.id, {
      username: user.username,
      name: user.name,
      boardId: null,
    }); //[cite: 2]
    io.emit("presence:update", Array.from(activeUsers.values())); //[cite: 2]
  }

  // 게시판 입장[cite: 2]
  socket.on("board:join", (boardId) => {
    socket.join(boardId); //[cite: 2]
    if (activeUsers.has(socket.id)) {
      activeUsers.get(socket.id).boardId = boardId; //[cite: 2]
      io.emit("presence:update", Array.from(activeUsers.values())); //[cite: 2]
    }
  });

  // 실시간 타이핑 신호 전송[cite: 2]
  socket.on("memo:typing", ({ boardId, memoId, field }) => {
    socket.to(boardId).emit("memo:typing", { memoId, user: user?.name, field }); //[cite: 2]
  });

  // 메모 신규 생성 / 수정 방송[cite: 2]
  socket.on("memo:save", async (memoData) => {
    memoData.last_edited_by = user?.name || "익명"; //[cite: 2]
    memoData.updated_at = new Date().toISOString(); //[cite: 2]

    let result; //[cite: 2]
    if (memoData.id) {
      const { data } = await supabase
        .from("memos")
        .update(memoData)
        .eq("id", memoData.id)
        .select(); //[cite: 2]
      result = data ? data[0] : null; //[cite: 2]
    } else {
      const { data } = await supabase.from("memos").insert([memoData]).select(); //[cite: 2]
      result = data ? data[0] : null; //[cite: 2]
    }

    if (result) {
      io.to(result.board_id).emit("memo:updated", result); //[cite: 2]
    }
  });

  // 좋아요 클릭[cite: 2]
  socket.on("memo:like", async ({ memoId, boardId }) => {
    const { data: memo } = await supabase
      .from("memos")
      .select("likes")
      .eq("id", memoId)
      .single(); //[cite: 2]
    if (memo) {
      const newLikes = (memo.likes || 0) + 1; //[cite: 2]
      await supabase.from("memos").update({ likes: newLikes }).eq("id", memoId); //[cite: 2]
      io.to(boardId).emit("memo:liked", { memoId, likes: newLikes }); //[cite: 2]
    }
  });

  socket.on("disconnect", () => {
    activeUsers.delete(socket.id); //[cite: 2]
    io.emit("presence:update", Array.from(activeUsers.values())); //[cite: 2]
  });
});

const PORT = process.env.PORT || 3000; //[cite: 2]
server.listen(PORT, () => {
  console.log(`🎬 릴스 노트패드 서버 실행 중: http://localhost:${PORT}`); //[cite: 2]
});

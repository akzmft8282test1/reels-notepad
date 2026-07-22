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

// --- 헬퍼: 활동 로그 기록 ---
async function logAction(username, action, details) {
  try {
    await supabase.from("audit_logs").insert([{ username, action, details }]);
  } catch (e) {
    console.error("Log error:", e);
  }
}

// --- 라우트 ---

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 로그인
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

  let isValidPassword =
    user.password && user.password.startsWith("$2")
      ? await bcrypt.compare(password, user.password)
      : password === user.password;

  if (!isValidPassword) {
    return res
      .status(401)
      .json({ success: false, message: "비밀번호가 올바르지 않습니다." });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role || "Member",
  };
  await logAction(user.username, "LOGIN", "로그인 성공");
  res.json({ success: true, user: req.session.user });
});

// 계정 추가 API (관리자용)
app.post("/api/admin/users", async (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password) {
    return res
      .status(400)
      .json({ success: false, message: "모든 항목을 입력해주세요." });
  }

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

// 로그인 정보 확인
app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user });
});

// 로그아웃
app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// 게시판 목록
app.get("/api/boards", async (req, res) => {
  const { data, error } = await supabase
    .from("boards")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 새 게시판 생성
app.post("/api/boards", async (req, res) => {
  if (!req.session.user || req.session.user.role === "Viewer") {
    return res.status(403).json({ message: "권한이 없습니다." });
  }
  const { name, description } = req.body;
  const { data, error } = await supabase
    .from("boards")
    .insert([{ name, description }])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// 메모 목록 조회
app.get("/api/memos/:boardId", async (req, res) => {
  const { boardId } = req.params;
  const { data, error } = await supabase
    .from("memos")
    .select("*")
    .eq("board_id", boardId)
    .eq("is_deleted", false)
    .order("is_pinned", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 휴지통 조회 (60일 보관)
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
    .gte("deleted_at", sixtyDaysAgo)
    .order("deleted_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 메모 상태/위치 변경 (드래그 앤 드롭)
app.post("/api/memos/status", async (req, res) => {
  if (!req.session.user || req.session.user.role === "Viewer") {
    return res.status(403).json({ message: "권한이 없습니다." });
  }
  const { memoId, status } = req.body;
  const { data, error } = await supabase
    .from("memos")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", memoId)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  io.to(data[0].board_id).emit("memo:updated", data[0]);
  res.json({ success: true, memo: data[0] });
});

// 메모 복구 API
app.post("/api/memos/restore", async (req, res) => {
  if (!req.session.user || req.session.user.role === "Viewer") {
    return res.status(403).json({ message: "권한이 없습니다." });
  }
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

// 활동 로그 조회
app.get("/api/admin/logs", async (req, res) => {
  if (!req.session.user || req.session.user.role !== "Admin") {
    return res.status(403).json({ message: "관리자 전용 기능입니다." });
  }
  const { data, error } = await supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 댓글 가져오기
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

// 히스토리 가져오기
app.get("/api/history/:memoId", async (req, res) => {
  const { memoId } = req.params;
  const { data, error } = await supabase
    .from("script_history")
    .select("*")
    .eq("memo_id", memoId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Socket.io 실시간 협업 ---
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

  // 서식 있는 텍스트 및 메모 저장
  socket.on("memo:save", async (memoData) => {
    if (user?.role === "Viewer") return;

    memoData.last_edited_by = user?.name || "익명";
    memoData.updated_at = new Date().toISOString();

    let result;
    if (memoData.id) {
      const { data: oldMemo } = await supabase
        .from("memos")
        .select("script")
        .eq("id", memoData.id)
        .single();
      if (oldMemo && oldMemo.script !== memoData.script) {
        await supabase.from("script_history").insert([
          {
            memo_id: memoData.id,
            script: oldMemo.script,
            edited_by: user?.name || "익명",
          },
        ]);
      }

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

  // 소프트 삭제 (휴지통 이동)
  socket.on("memo:delete", async ({ memoId, boardId }) => {
    if (user?.role === "Viewer") return;
    await supabase
      .from("memos")
      .update({ is_deleted: true, deleted_at: new Date().toISOString() })
      .eq("id", memoId);
    io.to(boardId).emit("memo:updated", { id: memoId, is_deleted: true });
  });

  // 댓글 작성
  socket.on("comment:add", async ({ memoId, boardId, content }) => {
    if (!content || user?.role === "Viewer") return;
    const { data: comment } = await supabase
      .from("comments")
      .insert([{ memo_id: memoId, author: user?.name || "익명", content }])
      .select();

    if (comment) {
      io.to(boardId).emit("comment:added", { memoId, comment: comment[0] });
      const mentions = content.match(/@([^\s]+)/g);
      if (mentions) {
        mentions.forEach((m) => {
          const targetName = m.replace("@", "");
          io.emit("notification:mention", {
            targetName,
            from: user?.name,
            content,
            memoId,
          });
        });
      }
    }
  });

  // 좋아요
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
    io.emit("cursor:remove", socket.id);
    activeUsers.delete(socket.id);
    io.emit("presence:update", Array.from(activeUsers.values()));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 피그마/슬랙형 협업 메모장 실행 중: http://localhost:${PORT}`);
});

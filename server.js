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
  await logAction(user.username, "LOGIN", "로그인 성공");
  res.json({ success: true, user: req.session.user });
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user });
});

app.post("/api/logout", (req, res) => {
  if (req.session.user)
    logAction(req.session.user.username, "LOGOUT", "로그아웃");
  req.session.destroy();
  res.json({ success: true });
});

// 팀원 유저 목록 조회 (@멘션 자동완성용)
app.get("/api/users", async (req, res) => {
  const { data, error } = await supabase
    .from("allowed_users")
    .select("username, name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 관리자 계정 추가
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
    await logAction(
      req.session.user?.username || "ADMIN",
      "CREATE_USER",
      `계정 생성: ${username}`,
    );
    res.json({ success: true, user: data[0] });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: "서버 오류가 발생했습니다." });
  }
});

// 게시판 목록 및 생성
app.get("/api/boards", async (req, res) => {
  const { data, error } = await supabase
    .from("boards")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/boards", async (req, res) => {
  if (!req.session.user || req.session.user.role === "Viewer")
    return res.status(403).json({ message: "권한이 없습니다." });
  const { name, description } = req.body;
  const { data, error } = await supabase
    .from("boards")
    .insert([{ name, description: description || "" }])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  await logAction(
    req.session.user.username,
    "CREATE_BOARD",
    `게시판 생성: ${name}`,
  );
  res.json(data[0]);
});

// 메모 목록 조회 (휴지통 제외)
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

// 휴지통 및 복구 API
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

// 칸반 드래그 이동 API
app.post("/api/memos/status", async (req, res) => {
  if (!req.session.user || req.session.user.role === "Viewer")
    return res.status(403).json({ message: "권한이 없습니다." });
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

// 댓글, 히스토리, 활동로그 API
app.get("/api/comments/:memoId", async (req, res) => {
  const { data, error } = await supabase
    .from("comments")
    .select("*")
    .eq("memo_id", req.params.memoId)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/history/:memoId", async (req, res) => {
  const { data, error } = await supabase
    .from("script_history")
    .select("*")
    .eq("memo_id", req.params.memoId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 활동 로그 조회 API
app.get("/api/logs", async (req, res) => {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/admin/logs", async (req, res) => {
  if (!req.session.user || req.session.user.role !== "Admin")
    return res.status(403).json({ message: "권한이 없습니다." });
  const { data, error } = await supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 캔버스 연동 API
app.get("/api/connections/:boardId", async (req, res) => {
  const { data, error } = await supabase
    .from("memo_connections")
    .select("*")
    .eq("board_id", req.params.boardId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/drawings/:boardId", async (req, res) => {
  const { data, error } = await supabase
    .from("canvas_drawings")
    .select("*")
    .eq("board_id", req.params.boardId);
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
      socket
        .to(userInfo.boardId)
        .emit("cursor:update", {
          socketId: socket.id,
          name: userInfo.name,
          x: pos.x,
          y: pos.y,
        });
    }
  });

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
        await supabase
          .from("script_history")
          .insert([
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
      await logAction(
        user?.username || "ANON",
        "SAVE_MEMO",
        `저장: ${result.title}`,
      );
      io.to(result.board_id).emit("memo:updated", result);
    }
  });

  socket.on("memo:delete", async ({ memoId, boardId }) => {
    if (user?.role === "Viewer") return;
    await supabase
      .from("memos")
      .update({ is_deleted: true, deleted_at: new Date().toISOString() })
      .eq("id", memoId);
    await logAction(user?.username || "ANON", "DELETE_MEMO", `삭제: ${memoId}`);
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
      const mentions = content.match(/@([^\s]+)/g);
      if (mentions) {
        mentions.forEach((m) => {
          io.emit("notification:mention", {
            targetName: m.replace("@", ""),
            from: user?.name,
            content,
            memoId,
          });
        });
      }
    }
  });

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

  socket.on("memo:move", async ({ memoId, boardId, pos_x, pos_y }) => {
    if (user?.role === "Viewer") return;
    await supabase.from("memos").update({ pos_x, pos_y }).eq("id", memoId);
    socket.to(boardId).emit("memo:moved", { memoId, pos_x, pos_y });
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

  socket.on("disconnect", () => {
    io.emit("cursor:remove", socket.id);
    activeUsers.delete(socket.id);
    io.emit("presence:update", Array.from(activeUsers.values()));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 피그마/칸반 협업 스튜디오 실행 중: http://localhost:${PORT}`);
});

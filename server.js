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
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_ANON_KEY || "placeholder",
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

// === 로그인 API ===
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

app.get("/api/users", async (req, res) => {
  const { data, error } = await supabase
    .from("allowed_users")
    .select("username, name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// === 게시판 API ===
app.get("/api/boards", async (req, res) => {
  const { data, error } = await supabase
    .from("boards")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/api/boards", async (req, res) => {
  if (!req.session.user || req.session.user.role === "Viewer") {
    return res.status(403).json({ message: "권한이 없습니다." });
  }
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

app.delete("/api/boards/:id", async (req, res) => {
  if (
    !req.session.user ||
    (req.session.user.role !== "Admin" && req.session.user.role !== "Member")
  ) {
    return res
      .status(403)
      .json({ success: false, message: "게시판 삭제 권한이 없습니다." });
  }
  const boardId = req.params.id;
  try {
    await supabase.from("memos").delete().eq("board_id", boardId);
    await supabase.from("canvas_drawings").delete().eq("board_id", boardId);
    await supabase.from("shapes").delete().eq("board_id", boardId);
    await supabase.from("connectors").delete().eq("board_id", boardId);
    const { error } = await supabase.from("boards").delete().eq("id", boardId);
    if (error) throw error;

    await logAction(
      req.session.user.username,
      "DELETE_BOARD",
      `게시판 삭제: ${boardId}`,
    );
    io.emit("board:deleted", boardId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/api/boards/size", async (req, res) => {
  const { boardId, width, height } = req.body;
  try {
    await supabase
      .from("boards")
      .update({ canvas_width: width, canvas_height: height })
      .eq("id", boardId);
    io.to(boardId).emit("canvas:resized", { width, height });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === 도형(Shapes) API (500 에러 해결 적용) ===
app.get("/api/shapes/:boardId", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("shapes")
      .select("*")
      .eq("board_id", req.params.boardId);
    if (error) return res.json([]);
    res.json(data || []);
  } catch (e) {
    res.json([]);
  }
});

app.post("/api/shapes", async (req, res) => {
  try {
    const shapeData = { ...req.body };
    // 커스텀 임시 ID인 경우 DB 자동 생성 및 타입 충돌 방지를 위해 id 삭제
    if (shapeData.id && String(shapeData.id).startsWith("shape-")) {
      delete shapeData.id;
    }

    const { data, error } = await supabase
      .from("shapes")
      .upsert([shapeData])
      .select();

    if (error) {
      console.error("Shape Insert Error:", error);
      return res.status(500).json({ error: error.message });
    }

    if (data && data[0]) {
      io.to(shapeData.board_id).emit("shape:updated", data[0]);
      res.json(data[0]);
    } else {
      res.status(500).json({ error: "도형 생성 실패" });
    }
  } catch (e) {
    console.error("Shape Catch Error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/shapes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data } = await supabase
      .from("shapes")
      .select("board_id")
      .eq("id", id)
      .single();
    await supabase.from("shapes").delete().eq("id", id);
    if (data) io.to(data.board_id).emit("shape:deleted", id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === 연결선(Connectors) API (500 에러 해결 적용) ===
app.get("/api/connectors/:boardId", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("connectors")
      .select("*")
      .eq("board_id", req.params.boardId);
    if (error) return res.json([]);
    res.json(data || []);
  } catch (e) {
    res.json([]);
  }
});

app.post("/api/connectors", async (req, res) => {
  try {
    const connData = { ...req.body };
    // 커스텀 임시 ID인 경우 DB 타입 충돌 방지를 위해 id 삭제
    if (connData.id && String(connData.id).startsWith("conn-")) {
      delete connData.id;
    }

    const { data, error } = await supabase
      .from("connectors")
      .upsert([connData])
      .select();

    if (error) {
      console.error("Connector Insert Error:", error);
      return res.status(500).json({ error: error.message });
    }

    if (data && data[0]) {
      io.to(connData.board_id).emit("connector:updated", data[0]);
      res.json(data[0]);
    } else {
      res.status(500).json({ error: "연결선 생성 실패" });
    }
  } catch (e) {
    console.error("Connector Catch Error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/connectors/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data } = await supabase
      .from("connectors")
      .select("board_id")
      .eq("id", id)
      .single();
    await supabase.from("connectors").delete().eq("id", id);
    if (data) io.to(data.board_id).emit("connector:deleted", id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === 메모/대본 CRUD API ===
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
  res.json(data || []);
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
    .gte("deleted_at", sixtyDaysAgo)
    .order("deleted_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

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

app.get("/api/comments/:memoId", async (req, res) => {
  const { data, error } = await supabase
    .from("comments")
    .select("*")
    .eq("memo_id", req.params.memoId)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get("/api/history/:memoId", async (req, res) => {
  const { data, error } = await supabase
    .from("script_history")
    .select("*")
    .eq("memo_id", req.params.memoId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get("/api/logs", async (req, res) => {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// === Socket.io Realtime ===
const activeUsers = new Map();

io.on("connection", (socket) => {
  const req = socket.request;
  const user = req.session?.user;

  if (user) {
    activeUsers.set(socket.id, {
      socketId: socket.id,
      username: user.username,
      name: user.name,
      role: user.role,
      boardId: null,
      x: 0,
      y: 0,
    });
    io.emit("presence:update", Array.from(activeUsers.values()));
  }

  socket.on("board:join", (boardId) => {
    socket.join(boardId);
    if (activeUsers.has(socket.id)) {
      activeUsers.get(socket.id).boardId = boardId;
      const currentBoardUsers = Array.from(activeUsers.values()).filter(
        (u) => u.boardId === boardId,
      );
      io.to(boardId).emit("presence:update", currentBoardUsers);
    }
  });

  socket.on("cursor:move", ({ boardId, x, y }) => {
    if (activeUsers.has(socket.id)) {
      const u = activeUsers.get(socket.id);
      u.x = x;
      u.y = y;
      socket.to(boardId).emit("cursor:moved", {
        socketId: socket.id,
        name: u.name,
        x,
        y,
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
    if (comment)
      io.to(boardId).emit("comment:added", { memoId, comment: comment[0] });
  });

  socket.on(
    "memo:move",
    async ({ memoId, boardId, pos_x, pos_y, group_id }) => {
      if (user?.role === "Viewer") return;
      await supabase
        .from("memos")
        .update({ pos_x, pos_y, group_id })
        .eq("id", memoId);
      socket.to(boardId).emit("memo:moved", { memoId, pos_x, pos_y, group_id });
    },
  );

  socket.on("drawing:stroke", ({ boardId, strokeData }) => {
    if (user?.role === "Viewer") return;
    socket.to(boardId).emit("drawing:stroke", strokeData);
  });

  socket.on("drawing:clear", (boardId) => {
    if (user?.role === "Viewer") return;
    io.to(boardId).emit("drawing:cleared");
  });

  socket.on("disconnect", () => {
    const u = activeUsers.get(socket.id);
    activeUsers.delete(socket.id);
    if (u && u.boardId) {
      const currentBoardUsers = Array.from(activeUsers.values()).filter(
        (usr) => usr.boardId === u.boardId,
      );
      io.to(u.boardId).emit("presence:update", currentBoardUsers);
      io.to(u.boardId).emit("cursor:left", socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(
    `🎬 릴스 협업 노트패드 스튜디오 실행 중: http://localhost:${PORT}`,
  );
});

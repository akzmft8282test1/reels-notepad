const socket = io();
let currentUser = null;
let currentBoardId = null;
let activeSelectedMemoId = null;
let activeSelectedElement = null;
let selectedElements = []; // 다중 선택된 엘리먼트 배열
let selectedMemoForComment = null;
let clipboardData = null;
let quill = null;
let activeView = "kanban";
let currentTool = "pan";
let memosCache = {};
let shapesCache = {};

let isGridSnapEnabled = localStorage.getItem("gridSnap") !== "false";
let gridSnapSize = 20;

let canvasWidth = parseInt(localStorage.getItem("savedCanvasWidth")) || 3000;
let canvasHeight = parseInt(localStorage.getItem("savedCanvasHeight")) || 3000;
let isAutoResizing = false;
let resizeTimer = null;

let pCanvas = null;
let ctx = null;
let isDrawing = false;
let lastX = 0,
  lastY = 0;

let isPanning = false;
let panStart = { x: 0, y: 0 };
let canvasPos = { x: 0, y: 0 };
let zoomLevel = 1.0;

// 다크모드 로컬스토리지 유지
if (localStorage.getItem("darkMode") === "true") {
  document.body.classList.add("dark-mode");
}

// 캔버스 크기 적용 함수
function applyCanvasSize(w, h) {
  canvasWidth = w;
  canvasHeight = h;
  if (pCanvas) {
    pCanvas.width = w;
    pCanvas.height = h;
  }
  const sizeInfo = document.getElementById("canvasSizeInfo");
  if (sizeInfo) {
    sizeInfo.innerText = `${w}x${h}px`;
  }
}

// 로그인 함수 (Form Submit 이벤트 처리 및 /? 방지)
async function login(e) {
  if (e) e.preventDefault(); // 폼 제출 시 페이지 새로고침 및 주소 이동 방지

  const usernameInput = document.getElementById("username").value;
  const passwordInput = document.getElementById("password").value;

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: usernameInput,
        password: passwordInput,
      }),
    });

    const data = await res.json();
    if (data.success) {
      location.reload(); // 로그인 성공 시 메인 화면으로 새로고침
    } else {
      alert(data.message || "로그인 실패");
    }
  } catch (err) {
    console.error("Login error:", err);
    alert("로그인 처리 중 오류가 발생했습니다.");
  }
}

window.onload = () => {
  quill = new Quill("#quillEditor", { theme: "snow" });

  pCanvas = document.getElementById("paintCanvas");
  ctx = pCanvas.getContext("2d");

  applyCanvasSize(canvasWidth, canvasHeight);
  updateGridSnapUI();

  // 모바일/터치 지원 캔버스 드로잉 이벤트
  const getCanvasCoords = (e) => {
    const rect = pCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) / zoomLevel,
      y: (clientY - rect.top) / zoomLevel,
    };
  };

  const startDraw = (e) => {
    if (currentTool !== "pen" && currentTool !== "eraser") return;
    isDrawing = true;
    const coords = getCanvasCoords(e);
    lastX = coords.x;
    lastY = coords.y;
  };

  const moveDraw = (e) => {
    if (!isDrawing) return;
    const coords = getCanvasCoords(e);

    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(coords.x, coords.y);

    if (currentTool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = 25;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = document.getElementById("penColor").value;
      ctx.lineWidth = 4;
    }
    ctx.lineCap = "round";
    ctx.stroke();

    socket.emit("drawing:stroke", {
      boardId: currentBoardId,
      strokeData: {
        tool: currentTool,
        x1: lastX,
        y1: lastY,
        x2: coords.x,
        y2: coords.y,
        color: document.getElementById("penColor").value,
      },
    });

    lastX = coords.x;
    lastY = coords.y;
  };

  const stopDraw = () => {
    isDrawing = false;
  };

  pCanvas.addEventListener("mousedown", startDraw);
  pCanvas.addEventListener("mousemove", moveDraw);
  window.addEventListener("mouseup", stopDraw);

  pCanvas.addEventListener("touchstart", startDraw, { passive: false });
  pCanvas.addEventListener("touchmove", moveDraw, { passive: false });
  window.addEventListener("touchend", stopDraw);

  // 무한 캔버스 이동(Pan) & 줌
  const canvasView = document.getElementById("canvasView");
  const container = document.getElementById("canvasContainer");

  canvasView.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        zoomLevel += e.deltaY < 0 ? 0.05 : -0.05;
        zoomLevel = Math.min(Math.max(0.3, zoomLevel), 2.5);
        updateCanvasTransform();
      }
    },
    { passive: false },
  );

  canvasView.addEventListener("mousemove", (e) => {
    if (currentBoardId && currentUser) {
      const rect = container.getBoundingClientRect();
      socket.emit("cursor:move", {
        boardId: currentBoardId,
        name: currentUser.name,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    }
  });

  canvasView.addEventListener("mousedown", (e) => {
    if (
      currentTool === "pan" &&
      !e.target.closest(".canvas-card, .sticky-note")
    ) {
      isPanning = true;
      panStart = { x: e.clientX - canvasPos.x, y: e.clientY - canvasPos.y };
      canvasView.style.cursor = "grabbing";
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (isPanning) {
      canvasPos.x = e.clientX - panStart.x;
      canvasPos.y = e.clientY - panStart.y;
      updateCanvasTransform();
    }
  });

  window.addEventListener("mouseup", () => {
    if (isPanning) {
      isPanning = false;
      if (currentTool === "pan") canvasView.style.cursor = "grab";
    }
  });

  // 단축키 매핑
  window.addEventListener("keydown", (e) => {
    const activeTag = document.activeElement
      ? document.activeElement.tagName.toLowerCase()
      : "";
    if (
      activeTag === "input" ||
      activeTag === "textarea" ||
      document.activeElement.classList.contains("ql-editor")
    )
      return;

    if (e.key.toLowerCase() === "v") setTool("select");
    if (e.key.toLowerCase() === "h") setTool("pan");
    if (e.key.toLowerCase() === "p") setTool("pen");
    if (e.key === "?")
      document.getElementById("cheatSheetModal").style.display = "flex";

    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelectedElement();
    }
  });

  // 이미지/영상 드래그 앤 드롭
  container.addEventListener("dragover", (e) => e.preventDefault());
  container.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files.length) return;

    Array.from(files).forEach((file) => {
      const url = URL.createObjectURL(file);
      const card = document.createElement("div");
      card.className = "canvas-card";
      card.style.left = `${(e.clientX - canvasPos.x) / zoomLevel}px`;
      card.style.top = `${(e.clientY - canvasPos.y) / zoomLevel}px`;

      if (file.type.startsWith("image/")) {
        card.innerHTML = `<img src="${url}" style="max-width:200px; border-radius:4px;">`;
      } else if (file.type.startsWith("video/")) {
        card.innerHTML = `<video src="${url}" controls style="max-width:220px; border-radius:4px;"></video>`;
      }
      container.appendChild(card);
      makeDraggable(card);
    });
  });

  init();
};

// 그리드 스냅 토글 및 설정
function toggleGridSnap() {
  isGridSnapEnabled = !isGridSnapEnabled;
  localStorage.setItem("gridSnap", isGridSnapEnabled);
  updateGridSnapUI();
}

function updateGridSnapUI() {
  const btn = document.getElementById("btnGridSnap");
  const container = document.getElementById("canvasContainer");
  if (btn) btn.innerText = `🧲 그리드스냅: ${isGridSnapEnabled ? "ON" : "OFF"}`;
  if (container) {
    if (isGridSnapEnabled) container.classList.add("grid-snapping");
    else container.classList.remove("grid-snapping");
  }
}

function snapToGrid(val) {
  if (!isGridSnapEnabled) return val;
  return Math.round(val / gridSnapSize) * gridSnapSize;
}

// 개체 범용 드래그 & 모바일 터치 대응
function makeDraggable(element) {
  let isDragging = false;
  let offsetLeft = 0,
    offsetTop = 0;

  const getEventCoords = (e) => ({
    x: e.touches ? e.touches[0].clientX : e.clientX,
    y: e.touches ? e.touches[0].clientY : e.clientY,
  });

  const onStart = (e) => {
    if (currentTool !== "select" || element.classList.contains("locked"))
      return;
    isDragging = true;
    const coords = getEventCoords(e);
    offsetLeft = coords.x / zoomLevel - element.offsetLeft;
    offsetTop = coords.y / zoomLevel - element.offsetTop;

    if (e.shiftKey) {
      element.classList.add("selected");
      if (!selectedElements.includes(element)) selectedElements.push(element);
    } else if (!selectedElements.includes(element)) {
      clearSelections();
      element.classList.add("selected");
      selectedElements = [element];
    }
  };

  const onMove = (e) => {
    if (!isDragging || currentTool !== "select") return;
    const coords = getEventCoords(e);
    const newX = snapToGrid(coords.x / zoomLevel - offsetLeft);
    const newY = snapToGrid(coords.y / zoomLevel - offsetTop);

    element.style.left = `${newX}px`;
    element.style.top = `${newY}px`;
  };

  const onEnd = () => {
    if (isDragging) {
      isDragging = false;
      const shapeId = element.dataset.shapeId;
      if (shapeId) {
        socket.emit("shape:save", {
          id: shapeId,
          board_id: currentBoardId,
          type: element.dataset.shapeType,
          pos_x: parseInt(element.style.left),
          pos_y: parseInt(element.style.top),
          content: element.querySelector("textarea")?.value || "",
        });
      }
    }
  };

  element.addEventListener("mousedown", onStart);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onEnd);

  element.addEventListener("touchstart", onStart, { passive: false });
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("touchend", onEnd);
}

function clearSelections() {
  document
    .querySelectorAll(".selected")
    .forEach((el) => el.classList.remove("selected"));
  selectedElements = [];
}

// 도형 & 스티키노트 영구 추가 API 연동
function addShape(type) {
  const id = "shape-" + Date.now();
  const shapeData = {
    id,
    board_id: currentBoardId,
    type,
    pos_x: snapToGrid(300 - canvasPos.x),
    pos_y: snapToGrid(300 - canvasPos.y),
    color: document.getElementById("penColor").value,
  };
  socket.emit("shape:save", shapeData);
}

function addStickyNote(color) {
  const id = "sticky-" + Date.now();
  const shapeData = {
    id,
    board_id: currentBoardId,
    type: "sticky",
    pos_x: snapToGrid(200 - canvasPos.x),
    pos_y: snapToGrid(200 - canvasPos.y),
    color,
  };
  socket.emit("shape:save", shapeData);
}

function renderShape(shape) {
  let el = document.getElementById(shape.id);
  if (!el) {
    if (shape.type === "sticky") {
      el = document.createElement("div");
      el.className = "sticky-note";
      el.innerHTML = `<textarea placeholder="아이디어 메모...">${shape.content || ""}</textarea>`;
      el.style.background = shape.color || "#fef08a";
      el.querySelector("textarea").onchange = (e) => {
        shape.content = e.target.value;
        socket.emit("shape:save", shape);
      };
    } else {
      el = document.createElement("div");
      el.className = "canvas-card";
      el.style.width = "120px";
      el.style.height = "120px";
      el.style.background = shape.color || "#e1306c";
      if (shape.type === "circle") el.style.borderRadius = "50%";
    }
    el.id = shape.id;
    el.dataset.shapeId = shape.id;
    el.dataset.shapeType = shape.type;
    makeDraggable(el);
    document.getElementById("canvasContainer").appendChild(el);
  }
  el.style.left = `${shape.pos_x}px`;
  el.style.top = `${shape.pos_y}px`;
}

// 선택 요소 삭제
function deleteSelectedElement() {
  if (selectedElements.length > 0) {
    selectedElements.forEach((el) => {
      const shapeId = el.dataset.shapeId;
      const memoId = el.dataset.id;
      if (shapeId)
        socket.emit("shape:delete", { id: shapeId, boardId: currentBoardId });
      else if (memoId) deleteMemo(memoId);
      el.remove();
    });
    selectedElements = [];
  }
}

// 다중 선택 그룹화 및 자동정렬
function groupSelectedElements() {
  selectedElements.forEach((el) => el.classList.toggle("grouped"));
}

function autoLayoutElements() {
  if (selectedElements.length < 2) return;
  selectedElements.sort((a, b) => a.offsetLeft - b.offsetLeft);
  const startX = selectedElements[0].offsetLeft;
  const startY = selectedElements[0].offsetTop;

  selectedElements.forEach((el, idx) => {
    el.style.left = `${startX + idx * 220}px`;
    el.style.top = `${startY}px`;
  });
}

// 캔버스 크기 조정 & 다크모드
function updateCanvasTransform() {
  const container = document.getElementById("canvasContainer");
  container.style.transform = `translate(${canvasPos.x}px, ${canvasPos.y}px) scale(${zoomLevel})`;
  updateMinimap();
}

function updateMinimap() {
  const viewport = document.getElementById("minimapViewport");
  if (!viewport) return;
  const ratioX = 160 / canvasWidth;
  const ratioY = 120 / canvasHeight;

  viewport.style.width = `${(window.innerWidth / zoomLevel) * ratioX}px`;
  viewport.style.height = `${(window.innerHeight / zoomLevel) * ratioY}px`;
  viewport.style.left = `${Math.max(0, -canvasPos.x * ratioX)}px`;
  viewport.style.top = `${Math.max(0, -canvasPos.y * ratioY)}px`;
}

function toggleDarkMode() {
  const isDark = document.body.classList.toggle("dark-mode");
  localStorage.setItem("darkMode", isDark);
}

// 실시간 검색
function handleSearch(keyword) {
  const term = keyword.toLowerCase();
  document
    .querySelectorAll(".card, .canvas-card, .sticky-note")
    .forEach((el) => {
      const text = el.innerText.toLowerCase();
      el.style.display = !term || text.includes(term) ? "block" : "none";
    });
}

// 기본 유틸 및 초기화
async function init() {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) {
      document.getElementById("loginView").style.display = "block";
      return;
    }
    const data = await res.json();
    if (data.loggedIn) {
      currentUser = data.user;
      document.getElementById("loginView").style.display = "none";
      switchView("kanban");
      loadBoards();
    }
  } catch (err) {
    console.log("비로그인 상태이거나 서버 연결에 실패했습니다.");
  }
}

async function loadBoards() {
  const res = await fetch("/api/boards");
  const boards = await res.json();
  const listEl = document.getElementById("boardList");
  listEl.innerHTML = "";

  boards.forEach((board, idx) => {
    const li = document.createElement("li");
    li.style.display = "flex";
    li.style.justifyContent = "space-between";
    li.innerHTML = `
      <span style="cursor:pointer;" onclick="selectBoard('${board.id}', '${board.name}')">${board.name}</span>
      <button style="width:auto; padding:2px 6px;" class="bg-red" onclick="deleteBoard('${board.id}')">🗑️</button>
    `;
    if ((idx === 0 && !currentBoardId) || currentBoardId === board.id) {
      selectBoard(board.id, board.name);
    }
    listEl.appendChild(li);
  });
}

function selectBoard(id, name) {
  currentBoardId = id;
  const titleEl = document.getElementById("currentBoardTitle");
  if (titleEl) titleEl.innerText = name;
  socket.emit("board:join", id);
  loadMemos();
  loadShapes();
}

async function loadShapes() {
  if (!currentBoardId) return;
  const res = await fetch(`/api/shapes/${currentBoardId}`);
  const shapes = await res.json();
  shapes.forEach(renderShape);
}

async function loadMemos() {
  if (!currentBoardId) return;
  const res = await fetch(`/api/memos/${currentBoardId}`);
  const memos = await res.json();
  if (activeView === "kanban") renderKanban(memos);
  else renderCanvas(memos);
}

function renderKanban(memos) {
  ["아이디어", "대본작성", "촬영예정", "완료"].forEach((s) => {
    const col = document.getElementById(`col-${s}`);
    if (col) col.innerHTML = "";
  });
  memos.forEach((memo) => {
    memosCache[memo.id] = memo;
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = memo.id;
    card.innerHTML = `
      <span class="badge">${memo.category || "일반"}</span>
      <h4>${memo.title}</h4>
      <div class="script-box">${memo.script || ""}</div>
      <div class="flex-gap mt-10">
        <button onclick="editMemo('${memo.id}')">✏️ 수정</button>
        <button class="bg-red" onclick="deleteMemo('${memo.id}')">🗑️ 삭제</button>
      </div>
    `;
    const targetCol = document.getElementById(
      `col-${memo.status || "아이디어"}`,
    );
    if (targetCol) targetCol.appendChild(card);
  });
}

function renderCanvas(memos) {
  const container = document.getElementById("canvasContainer");
  memos.forEach((memo) => {
    let card = document.getElementById(`card-${memo.id}`);
    if (!card) {
      card = document.createElement("div");
      card.className = "canvas-card";
      card.id = `card-${memo.id}`;
      card.dataset.id = memo.id;
      makeDraggable(card);
      container.appendChild(card);
    }
    card.style.left = `${memo.pos_x || 100}px`;
    card.style.top = `${memo.pos_y || 100}px`;
    card.innerHTML = `<h4>${memo.title}</h4><p>${memo.script || ""}</p>`;
  });
}

function setTool(tool) {
  currentTool = tool;
  document
    .querySelectorAll(".tool-btn")
    .forEach((b) => b.classList.remove("active"));
  document
    .getElementById(`btn${tool.charAt(0).toUpperCase() + tool.slice(1)}`)
    ?.classList.add("active");
}

function switchView(view) {
  activeView = view;
  document.getElementById("kanbanView").style.display =
    view === "kanban" ? "block" : "none";
  document.getElementById("canvasView").style.display =
    view === "canvas" ? "block" : "none";
  if (currentBoardId) loadMemos();
}

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
}
function closeModal(id) {
  document.getElementById(id).style.display = "none";
}

// 실시간 Presence 및 커서 이벤트
socket.on("presence:update", (users) => {
  const countEl = document.getElementById("onlineCount");
  if (countEl) countEl.innerText = `접속자: ${users.length}명`;
  document.querySelectorAll(".remote-cursor").forEach((el) => {
    if (!users.some((u) => u.id === el.id.replace("cursor-", ""))) el.remove();
  });
});

socket.on("cursor:moved", ({ id, name, x, y }) => {
  let el = document.getElementById(`cursor-${id}`);
  if (!el) {
    el = document.createElement("div");
    el.id = `cursor-${id}`;
    el.className = "remote-cursor";
    el.innerText = name;
    el.style.background = "#e1306c";
    document.getElementById("canvasContainer").appendChild(el);
  }
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
});

socket.on("shape:updated", (shape) => renderShape(shape));
socket.on("shape:deleted", (id) => document.getElementById(id)?.remove());
socket.on("memo:updated", () => loadMemos());

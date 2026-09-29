
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");

const questions = [
  {q:"Which keyword is used to define a function in Python?",o:["func","define","def","function"],a:2},
  {q:"What is the output of the following code?", code:"x = 10\nprint(x + 5)",o:["10","15","5","105"],a:1},
  {q:"Which symbol is used for a single-line comment in Python?",o:["//","#","/*","--"],a:1},
  {q:"What is the output of the following code?", code:"a = 5\nb = 2\nprint(a * b)",o:["7","10","25","3"],a:1},
  {q:"Which function is used to get input from the user?",o:["scan()","read()","input()","get()"],a:2},
  {q:"What is the output of the following code?", code:"for i in range(3):\n    print(i)",o:["1 2 3","0 1 2","0 1 2 3","3 2 1"],a:1},
  {q:"What is the index of the first element in a Python list?",o:["0","1","-1","2"],a:0},
  {q:"What is the output of the following code?", code:"x = [10, 20, 30]\nprint(x[1])",o:["10","20","30","1"],a:1},
  {q:"What is the output of len(\"Python\")?",o:["5","6","7","8"],a:1},
  {q:"Which collection stores data as key-value pairs?",o:["List","Tuple","Set","Dictionary"],a:3},
  {q:"What is the output of the following code?", code:"x = 8\nif x > 5:\n    print(\"Yes\")\nelse:\n    print(\"No\")",o:["Yes","No","8","Error"],a:0},
  {q:"What does the == operator check?",o:["Assignment","Identity only","Equality","Addition"],a:2},
  {q:"What is the output of the following code?", code:'name = "Python"\nprint(name[0])',o:["P","y","Python","0"],a:0},
  {q:"Which symbol is used to create a list in Python?",o:["()","{}","[]","<>"],a:2},
  {q:"What is the output of the following code?", code:"x = 3\nx += 2\nprint(x)",o:["3","2","5","6"],a:2}
];

const rooms = new Map();

function roomCode() {
  let code;
  do { code = Math.random().toString(36).slice(2,6).toUpperCase(); } while (rooms.has(code));
  return code;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(room, data) {
  for (const p of room.players.values()) send(p.ws, data);
}

function publicQuestion(room) {
  const q = questions[room.index];
  return { number: room.index + 1, total: questions.length, q:q.q, code:q.code || null, options:q.o };
}

function finishQuestion(room) {
  if (!room.active) return;
  room.active = false;
  if (room.timer) clearTimeout(room.timer);

  for (const p of room.players.values()) {
    p.answered = true;
    p.ws && send(p.ws, {
      type:"questionResult",
      correctIndex: questions[room.index].a,
      scores: Object.fromEntries([...room.players.values()].map(x=>[x.name,x.score]))
    });
  }

  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.index >= questions.length - 1) {
      room.finished = true;
      broadcast(room, {
        type:"final",
        leaderboard:[...room.players.values()]
          .sort((a,b)=>b.score-a.score)
          .map(p=>({name:p.name,score:p.score}))
      });
      return;
    }
    room.index++;
    startQuestion(room);
  }, 2500);
}

function startQuestion(room) {
  room.active = true;
  room.startedAt = Date.now();
  for (const p of room.players.values()) p.answered = false;
  broadcast(room, {type:"question", ...publicQuestion(room), seconds:20});
  room.timer = setTimeout(() => finishQuestion(room), 20000);
}

function createRoom(ws, name) {
  const code = roomCode();
  const room = {code, host:ws, index:0, active:false, finished:false, players:new Map(), timer:null, startedAt:0};
  rooms.set(code, room);
  ws.roomCode = code;
  ws.role = "host";
  send(ws, {type:"roomCreated", code});
}

function joinRoom(ws, name, code) {
  const room = rooms.get(code);
  if (!room) return send(ws,{type:"error",message:"Room not found."});
  if (room.finished) return send(ws,{type:"error",message:"This quiz is already finished."});
  const clean = String(name||"").trim().slice(0,24);
  if (!clean) return send(ws,{type:"error",message:"Enter your name."});
  if ([...room.players.values()].some(p=>p.name.toLowerCase()===clean.toLowerCase()))
    return send(ws,{type:"error",message:"That name is already used in this room."});

  const player = {ws,name:clean,score:0,answered:false};
  room.players.set(ws, player);
  ws.roomCode = code;
  ws.role = "player";
  send(ws,{type:"joined",code,name:clean,waiting:!room.active});
  broadcast(room,{type:"players",count:room.players.size,names:[...room.players.values()].map(p=>p.name)});
  if (room.active) send(ws,{type:"question",...publicQuestion(room),seconds:Math.max(1,20-Math.floor((Date.now()-room.startedAt)/1000))});
}

const server = http.createServer((req,res)=>{
  let file = req.url === "/" ? "/index.html" : req.url;
  file = path.normalize(file).replace(/^(\.\.[\/\\])+/, "");
  const full = path.join(publicDir,file);
  if (!full.startsWith(publicDir)) return res.writeHead(403).end();
  fs.readFile(full,(err,data)=>{
    if(err) return res.writeHead(404).end("Not found");
    const ext=path.extname(full);
    const type={".html":"text/html",".css":"text/css",".js":"application/javascript"}[ext]||"text/plain";
    res.writeHead(200,{"Content-Type":type}); res.end(data);
  });
});

const wss = new WebSocket.Server({server});
wss.on("connection", ws=>{
  ws.on("message", raw=>{
    let m; try{m=JSON.parse(raw)}catch{return}
    if(m.type==="create") createRoom(ws,m.name);
    if(m.type==="join") joinRoom(ws,m.name,String(m.code||"").toUpperCase());
    if(m.type==="start"){
      const room=rooms.get(ws.roomCode);
      if(room && room.host===ws && !room.active && !room.finished && room.players.size>0) startQuestion(room);
    }
    if(m.type==="answer"){
      const room=rooms.get(ws.roomCode);
      if(!room || !room.active || ws.role!=="player") return;
      const p=room.players.get(ws);
      if(!p || p.answered) return;
      p.answered=true;
      if(Number(m.index)===questions[room.index].a) p.score++;
      send(ws,{type:"answerReceived",correct:Number(m.index)===questions[room.index].a});
      const allAnswered=[...room.players.values()].every(x=>x.answered);
      if(allAnswered) finishQuestion(room);
    }
  });
  ws.on("close",()=>{
    const room=rooms.get(ws.roomCode);
    if(!room)return;
    if(room.host===ws){
      broadcast(room,{type:"error",message:"Host disconnected. Room closed."});
      if(room.timer)clearTimeout(room.timer);
      rooms.delete(room.code);
    }else{
      room.players.delete(ws);
      broadcast(room,{type:"players",count:room.players.size,names:[...room.players.values()].map(p=>p.name)});
    }
  });
});

server.listen(PORT,()=>console.log(`Quiz server running on port ${PORT}`));

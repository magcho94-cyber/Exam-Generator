
const express=require("express"), http=require("http"), QRCode=require("qrcode"), multer=require("multer"), crypto=require("crypto");
const OpenAI=require("openai");
const {Server}=require("socket.io"), {Pool}=require("pg");
const app=express(), srv=http.createServer(app), io=new Server(srv);
const up=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024}});
app.use(express.static("public")); app.use(express.json({limit:"15mb"}));

const AI_READY=!!process.env.OPENAI_API_KEY;
const openai=AI_READY?new OpenAI({apiKey:process.env.OPENAI_API_KEY}):null;
const AI_MODEL=process.env.OPENAI_MODEL||"gpt-5.6-luna";
const DB_READY=!!process.env.DATABASE_URL;
let pool=null;
if(DB_READY) pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const mem={history:[],students:{},vocabAttempts:[]};
async function initDB(){
 if(!pool)return;
 await pool.query(`create table if not exists exam_history(
 id bigserial primary key, school text, grade text, mode text, source_hash text, qtype text,
 question jsonb, created_at timestamptz default now())`);
 await pool.query(`create table if not exists vocab_attempts(
 id bigserial primary key, student text, class_name text, set_name text, total int, correct int,
 wrong_words jsonb, created_at timestamptz default now())`);
}
initDB().catch(console.error);

app.get("/api/status",(q,s)=>s.json({ai:AI_READY,db:DB_READY,version:"2.0.0",model:AI_MODEL}));
app.get("/api/config",(q,s)=>s.json({
 examTypes:["목적","심경 변화","주장","밑줄 의미/함의","요지","주제","제목","내용 일치","내용 불일치","어법","문맥상 어휘","빈칸","무관한 문장","글의 순서","문장 삽입","요약문","장문 제목","장문 어휘","장문 순서","지칭 대상","장문 내용 일치/불일치"],
 grammar:["시제","현재완료","과거완료","미래완료","수동태","조동사","to부정사","동명사","분사","분사구문","관계대명사","관계부사","접속사","가정법","비교","수일치","대명사","형용사·부사","1~5형식","지각동사","사역동사"],
 grammarFormats:["5지선다","괄호 양자택일","어법 오류 찾기","고쳐쓰기","영작","문장 형식 판단"]
}));

function sentences(t){return String(t||"").replace(/\r/g," ").split(/(?<=[.!?])\s+/).map(x=>x.trim()).filter(x=>/[A-Za-z]{3}/.test(x));}
app.post("/api/weekly/preview",(q,s)=>{
 const ss=sentences(q.body.passage); const n=Math.min(+q.body.translationCount||5,ss.length);
 s.json({translations:ss.slice(0,n).map((x,i)=>({no:i+1,sentence:x,answer:"학생이 직접 해석"})),
 grammarAIRequired:(q.body.grammarCount||0)>0, aiReady:AI_READY});
});
app.post("/api/ai-required",(q,s)=>s.status(503).json({error:"OpenAI API가 아직 연결되지 않았습니다. Render 환경변수 OPENAI_API_KEY를 등록하면 AI 출제가 활성화됩니다."}));
function hashText(t){return crypto.createHash("sha256").update(String(t||"").replace(/\s+/g," ").trim()).digest("hex")}
async function pastFor(hash,limit=35){if(pool){let r=await pool.query("select qtype,question,created_at from exam_history where source_hash=$1 order by created_at desc limit $2",[hash,limit]);return r.rows}return mem.history.filter(x=>x.source_hash===hash).slice(0,limit)}
async function saveGen(x){if(pool){await pool.query("insert into exam_history(school,grade,mode,source_hash,qtype,question) values($1,$2,$3,$4,$5,$6)",[x.school||"",x.grade||"",x.mode,x.source_hash,x.qtype||"mixed",JSON.stringify(x.question)])}else mem.history.unshift({...x,created_at:new Date().toISOString()})}
function priorText(rows){return rows.map((x,i)=>`[기출 ${i+1}] 유형:${x.qtype}\n${JSON.stringify(x.question)}`).join("\n\n").slice(0,24000)}
async function askAI(instructions,input){const r=await openai.responses.create({model:AI_MODEL,instructions,input,reasoning:{effort:"medium"}});return r.output_text||""}
app.post("/api/generate/exam",async(req,res)=>{try{if(!AI_READY)return res.status(503).json({error:"OpenAI API가 연결되지 않았습니다. OPENAI_API_KEY를 설정해주세요."});const b=req.body||{},passage=String(b.passage||"").trim();if(!passage)return res.status(400).json({error:"시험 범위 지문이 없습니다."});const h=hashText(passage),past=await pastFor(h);const types=(b.types||[]).length?b.types:["주제","제목","요지","내용 일치","빈칸"];
const instructions=`너는 한국 중고등학교 영어 내신 시험 출제 전문가다. 반드시 사용자가 제공한 원문에 근거한다. 원문에 없는 사실을 정답 근거로 만들지 않는다. 5지선다는 정답이 정확히 하나여야 한다. 난이도는 ${b.difficulty||"어려움"}. 가장 중요한 규칙: 아래 과거 출제 문항과 동일하거나 실질적으로 같은 문항을 만들지 않는다. 단순 표현 변경도 중복이다. 특히 같은 정답 근거, 같은 핵심 추론, 같은 선택지 논리, 같은 빈칸 위치를 반복하지 않는다. 가능한 경우 아직 사용하지 않은 근거와 관점을 우선한다. 각 문항 뒤에 '정답:'과 '근거:'를 명시한다.`;
const input=`[학교] ${b.school||""}\n[학년] ${b.grade||""}\n[문항 수] ${Math.min(Math.max(+b.count||10,1),50)}\n[허용 유형] ${types.join(", ")}\n\n[시험 범위 원문]\n${passage}\n\n[이미 출제된 문제 - 재사용 금지]\n${past.length?priorText(past):"없음"}\n\n새 시험을 작성하라. 번호를 붙이고 각 문항의 유형을 표시하라.`;
const text=await askAI(instructions,input);await saveGen({school:b.school,grade:b.grade,mode:"EXAM",source_hash:h,qtype:types.join(", "),question:{generated:text}});res.json({text,saved:Math.min(Math.max(+b.count||10,1),50),previousCompared:past.length});}catch(e){console.error(e);res.status(500).json({error:e.message})}});
app.post("/api/generate/weekly",async(req,res)=>{try{if(!AI_READY)return res.status(503).json({error:"OpenAI API가 연결되지 않았습니다. OPENAI_API_KEY를 설정해주세요."});const b=req.body||{},passage=String(b.passage||"").trim();if(!passage)return res.status(400).json({error:"지문이 없습니다."});const h=hashText(passage),past=await pastFor(h);const instructions=`JONGRO M ENGLISH의 WEEKLY TEST를 만든다. 제공 지문을 임의로 바꾸지 않는다. 해석 문항은 반드시 지문의 실제 문장을 그대로 사용한다. 문법 문제는 선택된 문법 항목과 형식을 우선한다. 기존 출제 이력과 의미상 같은 문제, 같은 정답 근거, 같은 오류 포인트를 반복하지 않는다. 정답과 간단한 근거를 마지막에 별도 답지로 제시한다.`;const input=`해석 ${+b.translationCount||0}문항, 문법 ${+b.grammarCount||0}문항\n문법 항목: ${(b.grammar||[]).join(", ")||"자율"}\n형식: ${(b.formats||[]).join(", ")||"5지선다"}\n\n[지문]\n${passage}\n\n[기출 - 반복 금지]\n${past.length?priorText(past):"없음"}`;const text=await askAI(instructions,input);await saveGen({mode:"WEEKLY",source_hash:h,qtype:"weekly",question:{generated:text}});res.json({text,saved:(+b.translationCount||0)+(+b.grammarCount||0),previousCompared:past.length});}catch(e){console.error(e);res.status(500).json({error:e.message})}});

app.get("/api/history",async(q,s)=>{
 try{if(pool){let r=await pool.query("select * from exam_history order by created_at desc limit 300");return s.json(r.rows)}
 s.json(mem.history)}catch(e){s.status(500).json({error:e.message})}
});
app.delete("/api/history",async(q,s)=>{try{if(pool)await pool.query("delete from exam_history");else mem.history=[];s.json({ok:true})}catch(e){s.status(500).json({error:e.message})}});

const R={};
app.post("/api/voca/room",async(req,res)=>{
 let c; do{c=String(Math.floor(100000+Math.random()*900000))}while(R[c]);
 let sets=req.body.sets||[]; R[c]={sets,i:-1,s:{},h:null,timer:null,nextTimer:null,deadline:0,locked:false,className:req.body.className||""};
 let u=req.protocol+"://"+req.get("host")+"/student.html?room="+c;
 res.json({c,u,qr:await QRCode.toDataURL(u,{width:300,margin:1})});
});
app.get("/api/voca/stats",async(q,s)=>{
 try{
  if(pool){let r=await pool.query("select * from vocab_attempts order by created_at desc limit 500");return s.json(r.rows)}
  s.json(mem.vocabAttempts);
 }catch(e){s.status(500).json({error:e.message})}
});
async function saveAttempt(st,r){
 const wrong=st.wrong||[];
 if(pool) await pool.query("insert into vocab_attempts(student,class_name,set_name,total,correct,wrong_words) values($1,$2,$3,$4,$5,$6)",
 [st.n,r.className,st.setName,st.total,st.correct,JSON.stringify(wrong)]);
 else mem.vocabAttempts.unshift({student:st.n,class_name:r.className,set_name:st.setName,total:st.total,correct:st.correct,wrong_words:wrong,created_at:new Date().toISOString()});
}
io.on("connection",s=>{
 s.on("host",c=>{if(!R[c])return;s.join(c);R[c].h=s.id});
 s.on("getSets",c=>{let r=R[c];if(!r)return s.emit("bad");s.emit("sets",r.sets.map(z=>({id:z.id,name:z.name})))});
 s.on("join",x=>{let r=R[x.c];if(!r)return s.emit("bad");let set=r.sets.find(z=>z.id===x.setId);if(!set)return s.emit("badSet");
   r.s[s.id]={n:(x.n||"학생").slice(0,20),setId:set.id,setName:set.name,score:0,correct:0,total:set.q.length,a:false,wrong:[],started:Date.now()};s.join(x.c);s.emit("ok",{setName:set.name});emitLobby(r)});
 function emitLobby(r){if(r.h)io.to(r.h).emit("names",Object.values(r.s))}
 function clear(r){clearTimeout(r.timer);clearTimeout(r.nextTimer);r.timer=r.nextTimer=null}
 function maxLen(r){return Math.max(0,...r.sets.map(z=>z.q.length))}
 function sendQuestion(r){const n=r.i+1;Object.entries(r.s).forEach(([id,st])=>{let set=r.sets.find(z=>z.id===st.setId),q=set?.q[r.i];
   if(q)io.to(id).emit("q",{n,total:set.q.length,t:q.t,o:q.o,deadline:r.deadline,setName:set.name});else st.a=true});
   if(r.h)io.to(r.h).emit("hostRound",{n,total:maxLen(r),deadline:r.deadline});
 }
 function next(c){let r=R[c];if(!r||r.locked)return;r.locked=true;clear(r);r.i++;Object.values(r.s).forEach(st=>st.a=false);
   if(r.i>=maxLen(r)){finish(r);r.locked=false;return}
   r.deadline=Date.now()+10000;sendQuestion(r);
   r.timer=setTimeout(()=>{r.timer=null;io.to(c).emit("timeup");r.nextTimer=setTimeout(()=>next(c),900)},10000);r.locked=false;
 }
 function active(r){return Object.values(r.s).filter(st=>r.sets.find(z=>z.id===st.setId)?.q[r.i])}
 function allDone(r){let a=active(r);return a.length>0&&a.every(st=>st.a)}
 async function finish(r){
   let all=Object.values(r.s).sort((a,b)=>b.correct-a.correct||b.score-a.score||(a.started-b.started));
   for(const st of all){try{await saveAttempt(st,r)}catch(e){console.error(e)}}
   if(r.h)io.to(r.h).emit("endHost",all);
   Object.keys(r.s).forEach(id=>io.to(id).emit("endStudent",{overall:all.slice(0,3)}));
 }
 s.on("start",next);s.on("next",next);
 s.on("ans",x=>{let r=R[x.c],st=r?.s[s.id];if(!st||st.a||Date.now()>r.deadline)return;let set=r.sets.find(z=>z.id===st.setId),q=set?.q[r.i];if(!q)return;
   st.a=true;let good=Number(x.a)===Number(q.a);if(good){st.score+=100;st.correct++}else st.wrong.push({word:q.word||q.t,correct:q.o?.[q.a-1]||q.a});
   s.emit("result",{good,correct:q.a});if(r.h)io.to(r.h).emit("scores",{students:Object.values(r.s),answered:active(r).filter(v=>v.a).length,total:active(r).length});
   if(allDone(r)){clear(r);io.to(x.c).emit("allAnswered");r.nextTimer=setTimeout(()=>next(x.c),1200)}
 });
 s.on("disconnect",()=>{for(const c in R){if(R[c].s[s.id]){delete R[c].s[s.id];emitLobby(R[c])}}});
});
srv.listen(process.env.PORT||3000);

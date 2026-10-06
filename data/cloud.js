const SUPABASE_URL="https://eftjjkvejsytvevgaynz.supabase.co";
const SUPABASE_KEY="sb_publishable_FxiVWn8wPHIay0AT-Od8Dg_pKlxfDMx";
const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY);
let cloudUser=null, cloudDisplayName="", quizResults=[], cloudAttemptSaved=false;

const $=id=>document.getElementById(id);
function authMsg(msg,ok=false){$("authMsg").textContent=msg;$("authMsg").style.color=ok?"#15803d":"#b91c1c"}
function setAuthUI(){
  const signed=!!cloudUser;
  $("authForm").classList.toggle("hidden",signed);
  $("authUser").classList.toggle("hidden",!signed);
  $("dashboardBtn").classList.toggle("hidden",!signed);
  if(signed)$("authUserText").textContent="已登入："+(cloudDisplayName||cloudUser.email||"使用者");
}
async function getProfile(){
  if(!cloudUser)return;
  const {data}=await sb.from("profiles").select("display_name").eq("id",cloudUser.id).maybeSingle();
  cloudDisplayName=data?.display_name||cloudUser.user_metadata?.display_name||cloudUser.email?.split("@")[0]||"";
}
function parseLocalDate(s){const d=new Date(s);return Number.isNaN(d.getTime())?0:d.getTime()}
async function syncWrongBank(){
  if(!cloudUser)return;
  const {data:rows,error}=await sb.from("wrong_answers").select("*").eq("user_id",cloudUser.id);
  if(error){authMsg("錯題同步失敗："+error.message);return}
  const merged={};
  for(const r of rows||[]){
    const k=key(r.unit_code,r.word,r.question_type);
    merged[k]={set:r.unit_code,word:r.word,type:r.question_type,count:r.wrong_count,last:new Date(r.last_wrong_at).toLocaleString()};
  }
  for(const set of order){
    const loc=loadUnitWrong(set);
    for(const [k,v] of Object.entries(loc)){
      const cur=merged[k];
      if(!cur || (v.count||0)>(cur.count||0) || parseLocalDate(v.last)>parseLocalDate(cur.last)) merged[k]=v;
    }
  }
  const upserts=Object.values(merged).map(v=>({
    user_id:cloudUser.id,unit_code:v.set,word:v.word,question_type:v.type,
    wrong_count:v.count||1,last_wrong_at:new Date(parseLocalDate(v.last)||Date.now()).toISOString()
  }));
  if(upserts.length) await sb.from("wrong_answers").upsert(upserts,{onConflict:"user_id,unit_code,word,question_type"});
  for(const set of order)localStorage.removeItem(storageKey(set));
  for(const v of Object.values(merged)){
    const obj=loadUnitWrong(v.set);obj[key(v.set,v.word,v.type)]=v;saveUnitWrong(v.set,obj);
  }
  wrongLog=loadAllWrong();
}
async function handleSession(session){
  cloudUser=session?.user||null;cloudDisplayName="";
  if(cloudUser){await getProfile();await syncWrongBank()}
  setAuthUI();
}
async function signUp(){
  const email=$("authEmail").value.trim(),password=$("authPassword").value,name=$("authName").value.trim();
  if(!email||password.length<6){authMsg("請輸入 Email；密碼至少 6 碼。");return}
  authMsg("建立帳號中…",true);
  const {data,error}=await sb.auth.signUp({email,password,options:{data:{display_name:name||email.split("@")[0]}}});
  if(error){authMsg(error.message);return}
  if(data.session){await handleSession(data.session);authMsg("帳號已建立並登入。",true)}
  else authMsg("帳號已建立。請到信箱完成驗證，再回來登入。",true);
}
async function signIn(){
  const email=$("authEmail").value.trim(),password=$("authPassword").value;
  if(!email||!password){authMsg("請輸入 Email 與密碼。");return}
  authMsg("登入中…",true);
  const {data,error}=await sb.auth.signInWithPassword({email,password});
  if(error){authMsg("登入失敗："+error.message);return}
  await handleSession(data.session);authMsg("登入成功，已同步個人錯題與學習紀錄。",true);
}
async function signOut(){await sb.auth.signOut();cloudUser=null;cloudDisplayName="";setAuthUI();$("dashboard").classList.add("hidden");authMsg("已登出。",true)}
async function cloudWrong(x){
  if(!cloudUser)return;
  const unitLog=loadUnitWrong(x.set),v=unitLog[key(x.set,x.word,x.type)];
  if(!v)return;
  await sb.from("wrong_answers").upsert({
    user_id:cloudUser.id,unit_code:x.set,word:x.word,question_type:x.type,
    wrong_count:v.count||1,last_wrong_at:new Date().toISOString()
  },{onConflict:"user_id,unit_code,word,question_type"});
}
async function saveProgress(){
  if(!cloudUser||!quizResults.length||cloudAttemptSaved)return;
  cloudAttemptSaved=true;
  const grouped={};
  for(const r of quizResults){
    if(!grouped[r.set])grouped[r.set]={total:0,correct:0,wrong:0};
    grouped[r.set].total++;if(r.good)grouped[r.set].correct++;else grouped[r.set].wrong++;
  }
  const mode=$("mode").value;
  for(const [unit,g] of Object.entries(grouped)){
    const score=g.total?Math.round(g.correct/g.total*10000)/100:0;
    await sb.from("quiz_attempts").insert({
      user_id:cloudUser.id,unit_code:unit,mode,total_questions:g.total,
      correct_count:g.correct,wrong_count:g.wrong,score_percent:score
    });
    const {data:old}=await sb.from("unit_progress").select("*").eq("user_id",cloudUser.id).eq("unit_code",unit).maybeSingle();
    await sb.from("unit_progress").upsert({
      user_id:cloudUser.id,unit_code:unit,
      attempts_count:(old?.attempts_count||0)+1,
      questions_answered:(old?.questions_answered||0)+g.total,
      correct_answers:(old?.correct_answers||0)+g.correct,
      wrong_answers:(old?.wrong_answers||0)+g.wrong,
      last_score_percent:score,
      best_score_percent:Math.max(Number(old?.best_score_percent||0),score),
      last_attempt_at:new Date().toISOString(),updated_at:new Date().toISOString()
    },{onConflict:"user_id,unit_code"});
  }
}
async function showDashboard(){
  if(!cloudUser)return;
  $("dashboard").classList.remove("hidden");$("quiz").classList.add("hidden");$("log").classList.add("hidden");
  $("dashBody").innerHTML="讀取中…";
  const [{data:p},{data:w}]=await Promise.all([
    sb.from("unit_progress").select("*").eq("user_id",cloudUser.id),
    sb.from("wrong_answers").select("unit_code,word,question_type,wrong_count,last_wrong_at").eq("user_id",cloudUser.id)
  ]);
  const pm={};for(const x of p||[])pm[x.unit_code]=x;
  const wm={};for(const x of w||[]){(wm[x.unit_code]||(wm[x.unit_code]=[])).push(x)}
  const rows=order.filter(u=>pm[u]||wm[u]).map(u=>{
    const x=pm[u]||{};const total=x.questions_answered||0,rate=total?Math.round((x.correct_answers||0)/total*100):0;
    const wrongs=(wm[u]||[]).sort((a,b)=>b.wrong_count-a.wrong_count);
    const wrongHtml=wrongs.length
      ? '<div style="margin-top:8px"><b>錯題明細：</b>'+wrongs.map(z=>'<div class="small" style="padding:5px 0">• <b>'+z.word+'</b>｜'+(z.question_type==="sentence"?"句子選字":"英翻中")+'｜答錯 '+z.wrong_count+' 次｜最近 '+new Date(z.last_wrong_at).toLocaleString()+'</div>').join("")+'</div>'
      : '<div class="small" style="margin-top:8px">目前沒有錯題。</div>';
    return '<div class="logrow"><b>'+names[u]+'</b><br><span class="small">測驗 '+(x.attempts_count||0)+' 次｜累計 '+total+' 題｜總正確率 '+rate+'%｜最高 '+(x.best_score_percent??"—")+'%｜目前錯題 '+wrongs.length+'</span>'+wrongHtml+'</div>'
  }).join("");
  $("dashBody").innerHTML=rows||"尚無學習紀錄，完成一次測驗後就會顯示。";
}

const originalStart=start;
start=function(retry=false){quizResults=[];cloudAttemptSaved=false;originalStart(retry)}
const originalAnswer=answer;
answer=function(v,b){
  if(locked)return;
  const x=quiz[i],ans=x.type==="sentence"?x.answer:x.zh,good=v===ans;
  quizResults.push({set:x.set,good});
  originalAnswer(v,b);
  if(!good)cloudWrong(x);
}
const originalRender=render;
render=function(){
  const done=i>=quiz.length&&quiz.length>0;
  originalRender();
  if(done)saveProgress();
}

$("authSignup").onclick=signUp;
$("authLogin").onclick=signIn;
$("authLogout").onclick=signOut;
$("dashboardBtn").onclick=showDashboard;
$("dashboardClose").onclick=()=>$("dashboard").classList.add("hidden");

$("clearlog").onclick=async()=>{
  if(sc.value==="ALL"){
    if(!confirm("確定清除所有單元的錯題紀錄？"))return;
    for(const set of order)localStorage.removeItem(storageKey(set));
    if(cloudUser)await sb.from("wrong_answers").delete().eq("user_id",cloudUser.id);
  }else{
    if(!confirm("確定清除 "+names[sc.value]+" 的錯題紀錄？"))return;
    localStorage.removeItem(storageKey(sc.value));
    if(cloudUser)await sb.from("wrong_answers").delete().eq("user_id",cloudUser.id).eq("unit_code",sc.value);
  }
  wrongLog=sc.value==="ALL"?loadAllWrong():loadUnitWrong(sc.value);showLog();
};

(async()=>{const {data:{session}}=await sb.auth.getSession();await handleSession(session);})();

const { spawn } = require('child_process'); const path=require('path'); const os=require('os'); const fs=require('fs'); const WebSocket=require('ws');
const PORT=3950+Math.floor(Math.random()*40), DATA=fs.mkdtempSync(path.join(os.tmpdir(),'jauto-'));
const srv=spawn(process.execPath,[path.join(__dirname,'..','server.js')],{env:Object.assign({},process.env,{PORT,DATA_DIR:DATA,DATABASE_URL:''})});
srv.stdout.on('data',async d=>{ if(!String(d).includes('서버 시작')) return;
  const ws=new WebSocket(`ws://localhost:${PORT}/ws`); let st=null, ups=0, days=[], fills=0;
  ws.on('message',m=>{ m=JSON.parse(m);
    if(m.t==='room:joined') ws.send(JSON.stringify({t:'host:settings',settings:{timeMode:'auto',autoSpeed:3}}));
    if(m.t==='room:state'&&m.phase==='lobby'&&m.settings.timeMode==='auto'&&!st){ st=1; ws.send(JSON.stringify({t:'host:start'})); }
    if(m.t==='market:snapshot'){ if(m.state.clock.day===1&&ups===0){ ws.send(JSON.stringify({t:'market:fx',reqId:'f1',dir:'toUsd',amount:500000})); } }
    if(m.t==='market:update'){ ups++; if(m.k===3&&!fills){ fills=1; ws.send(JSON.stringify({t:'market:order',reqId:'o1',cid:'HAMV',side:'buy',type:'market',qty:2})); } }
    if(m.t==='market:orderResult') console.log('result', m.reqId, m.ok, m.msg.slice(0,40));
    if(m.t==='day:advance'){ days.push(m.day); console.log('day advance ->', m.day, 'ticks seen', ups); if(days.length>=1){ console.log(ups>30&&days[0]===2?'AUTO OK':'AUTO FAIL'); ws.close(); srv.kill(); setTimeout(()=>{ try{ fs.rmSync(DATA,{recursive:true,force:true}); }catch(e){} process.exit(ups>30&&days[0]===2?0:1); },300); } } });
  ws.on('open',()=>ws.send(JSON.stringify({t:'room:create',nick:'자동',settings:{name:'자동 마을'}})));
});
setTimeout(()=>{ console.log('AUTO TIMEOUT'); srv.kill(); process.exit(1); }, 60000);

import React, {useEffect, useState} from 'react';
import {AbsoluteFill, Audio, continueRender, delayRender, staticFile, useCurrentFrame} from 'remotion';
import {B} from './theme';
import {F, fontsReady} from './fonts';
import {ease, prog} from './anim';
import {OpenGeniMark, OpenGeniWordmark} from './components/OpenGeniWordmark';
import timeline from './inside-product-timeline.json';

const serif: React.CSSProperties = {fontFamily:F.serif, fontStyle:'italic', fontWeight:400};
const reveal = (t:number, at=0) => prog(t, at, at + .5, ease.out);
const rise = (t:number, at=0): React.CSSProperties => ({opacity:reveal(t,at), transform:`translateY(${24*(1-reveal(t,at))}px)`});

type Product = {
  name:string; kind:string; number:string; bg:string; ink:string; muted:string; line:string;
  accent:string; bubble:string; request:string; action:string; completed:string; tool:string;
};
const products:Product[] = [
  {name:'hour',kind:'A booking app',number:'01',bg:'#101419',ink:'#f5f4ee',muted:'#a4b3ae',line:'#303a3a',accent:'#a8dfc1',bubble:'#223a30',request:'Move tomorrow’s clients to next week. And let them know.',action:'Approve changes',completed:'3 bookings moved. Clients notified.',tool:'move_booking'},
  {name:'thread',kind:'A commerce app',number:'02',bg:'#fff9f1',ink:'#412c26',muted:'#8b6b5a',line:'#e5d8c8',accent:'#954528',bubble:'#efe1d0',request:'Send Maya a return label for that jacket.',action:'Send return label',completed:'Return label sent to Maya.',tool:'create_return_label'},
  {name:'folio',kind:'A project workspace',number:'03',bg:'#f3f5ff',ink:'#17234f',muted:'#626d92',line:'#d5dbee',accent:'#4658b8',bubble:'#e0e6ff',request:'Turn this brief into a launch plan.',action:'Create launch plan',completed:'Launch plan created. 3 tasks assigned.',tool:'create_tasks'},
];

function Spark({color, size=28}:{color:string;size?:number}) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-label="Agent"><path d="M16 2C17 11 21 15 30 16C21 17 17 21 16 30C15 21 11 17 2 16C11 15 15 11 16 2Z" fill={color}/></svg>;
}

function Backdrop({t}:{t:number}) {
  return <AbsoluteFill style={{background:B.bg}}>
    <AbsoluteFill style={{opacity:.72,background:'radial-gradient(ellipse 90% 130% at 103% -15%, #ffb787ad, #ffb78700 70%), radial-gradient(ellipse 90% 120% at -10% 110%, #9fe3d3dc, #9fe3d300 70%)',transform:`scale(${1+.015*(1+Math.sin(t/12))})`}}/>
  </AbsoluteFill>;
}

function Masthead({t}:{t:number}) {
  return <div style={{position:'absolute',left:116,right:116,top:69,display:'flex',alignItems:'center',justifyContent:'space-between',opacity:1-prog(t,38.7,39.1)}}>
    <OpenGeniWordmark height={40} color={B.ink}/>
    <div style={{fontSize:27,color:B.muted,letterSpacing:'-.015em'}}>Agents inside your product.</div>
  </div>;
}

function Intro({t}:{t:number}) {
  const exit=prog(t,5.25,5.8,ease.inOut);
  return <AbsoluteFill style={{opacity:1-exit,transform:`translateY(${-42*exit}px)`}}>
    <div style={{position:'absolute',left:116,top:235,fontSize:174,lineHeight:1,letterSpacing:'-.065em',fontWeight:500}}>Agents.</div>
    <div style={{position:'absolute',left:116,top:415,fontSize:155,lineHeight:1.06,letterSpacing:'-.045em',...serif,...rise(t,.25)}}>Inside your product.</div>
    <div style={{position:'absolute',left:123,top:713,display:'flex',gap:22,...rise(t,1.3)}}>
      {products.map((p,i)=><div key={p.name} style={{display:'flex',alignItems:'center',gap:20,width:418,height:124,padding:'0 30px',borderRadius:24,background:p.bg,color:p.ink,boxShadow:'0 16px 36px #1113110c',transform:`translateY(${14*(1-reveal(t,1.3+i*.15))}px)`,opacity:reveal(t,1.3+i*.15)}}>
        <Spark color={p.accent} size={35}/><div style={{fontSize:42,fontWeight:600,letterSpacing:'-.04em'}}>{p.name}</div><div style={{fontSize:22,marginLeft:'auto',color:p.muted}}>{['Bookings','Commerce','Projects'][i]}</div>
      </div>)}
    </div>
  </AbsoluteFill>;
}

function Calendar({p,t,approved}:{p:Product;t:number;approved:boolean}) {
  const shift=prog(t,6.1,6.8,ease.out);
  const names=['Ben','Maya','Alex'];
  return <>
    <div style={{fontSize:30,color:p.muted,marginBottom:14}}>Ines’ studio</div>
    <div style={{fontSize:54,fontWeight:500,letterSpacing:'-.04em',marginBottom:35}}>{approved?'Next week. Sorted.':'Tomorrow’s bookings'}</div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16}}>
      {names.map((name,i)=><div key={name} style={{height:305,border:`1px solid ${p.line}`,borderRadius:17,padding:20,background:'#ffffff03'}}>
        <div style={{fontSize:22,color:p.muted,marginBottom:43}}>{approved?['MON','WED','THU'][i]:'TOMORROW'}</div>
        <div style={{padding:'21px 17px',borderRadius:12,background:p.bubble,borderLeft:`3px solid ${p.accent}`,transform:`translateY(${shift*(i+1)*12}px)`}}>
          <div style={{fontSize:32,fontWeight:500}}>{name}</div><div style={{fontSize:24,marginTop:8,color:p.muted}}>{['10:00','13:30','17:00'][i]}</div>
          <div style={{fontSize:19,marginTop:22,color:p.accent}}>{approved?'✓ Rescheduled':'Haircut · 45 min'}</div>
        </div>
      </div>)}
    </div>
  </>;
}

function Jacket({color}:{color:string}) {
  return <svg width="220" height="238" viewBox="0 0 180 200" fill="none" aria-label="Canvas jacket"><path d="M60 21L75 13H105L120 21L160 52L147 115L126 106L126 186H54L54 106L33 115L20 52L60 21Z" fill={color}/><path d="M75 13L90 45L105 13M90 45V186M61 86H80V110H61ZM101 86H120V110H101Z" stroke="#fff9f170" strokeWidth="2"/><circle cx="95" cy="65" r="2" fill="#fff9f1"/><circle cx="95" cy="130" r="2" fill="#fff9f1"/></svg>;
}

function Order({p,approved}:{p:Product;approved:boolean}) {
  return <>
    <div style={{fontSize:29,color:p.muted,marginBottom:14}}>Order #1048 · Maya Chen</div>
    <div style={{fontSize:54,fontWeight:500,letterSpacing:'-.04em',marginBottom:35}}>A better kind of return.</div>
    <div style={{display:'flex',gap:33,alignItems:'center',height:307,border:`1px solid ${p.line}`,borderRadius:18,padding:24}}>
      <div style={{display:'grid',placeItems:'center',width:246,height:257,background:'#eee2d0',borderRadius:13}}><Jacket color="#6d7255"/></div>
      <div><div style={{fontSize:36,fontFamily:F.serif,fontStyle:'italic'}}>The everyday jacket</div><div style={{fontSize:25,color:p.muted,marginTop:15}}>Olive · Medium</div><div style={{fontSize:27,marginTop:36,color:p.accent}}>{approved?'✓ Label sent':'Return requested'}</div></div>
    </div>
  </>;
}

function Projects({p,t,approved}:{p:Product;t:number;approved:boolean}) {
  const show=prog(t,5.45,6.05,ease.out);
  return <>
    <div style={{fontSize:29,color:p.muted,marginBottom:14}}>Summer launch · Project brief</div>
    <div style={{fontSize:54,fontWeight:500,letterSpacing:'-.04em',marginBottom:35}}>{approved?'From brief to plan.':'Let’s get this moving.'}</div>
    <div style={{height:307,border:`1px solid ${p.line}`,borderRadius:18,padding:27,position:'relative',overflow:'hidden'}}>
      <div style={{opacity:1-show}}><div style={{fontSize:31,fontWeight:500,marginBottom:25}}>Introduce the summer collection.</div><div style={{fontSize:29,color:p.muted,lineHeight:1.6}}>Landing page. Launch email.<br/>A campaign ready for Monday.</div></div>
      <div style={{position:'absolute',inset:22,opacity:show,transform:`translateY(${20*(1-show)}px)`}}>
        {['Landing page · Sam','Launch email · Nina','Campaign assets · Jo'].map((x,i)=><div key={x} style={{display:'flex',alignItems:'center',gap:17,height:72,marginBottom:15,padding:'0 20px',borderRadius:12,background:'#ffffff',fontSize:27,transform:`translateX(${(1-prog(t,5.45+i*.13,5.9+i*.13,ease.out))*40}px)`}}><span style={{width:21,height:21,border:`2px solid ${p.accent}`,borderRadius:6}}/>{x}<span style={{marginLeft:'auto',fontSize:20,color:p.muted}}>To do</span></div>)}
      </div>
    </div>
  </>;
}

function Pointer({x,y,click,color='#111311'}:{x:number;y:number;click:boolean;color?:string}) {
  return <div style={{position:'absolute',left:x,top:y,transform:`scale(${click?.86:1})`,transformOrigin:'0 0'}}>
    {click&&<div style={{position:'absolute',width:50,height:50,left:-25,top:-25,border:'3px solid #ffffffcc',borderRadius:'50%'}}/>}
    <svg width="34" height="43" viewBox="0 0 34 43"><path d="M2 2V33L11 25L19 41L26 38L18 23L31 22Z" fill={color} stroke="white" strokeWidth="2.5" strokeLinejoin="round"/></svg>
  </div>;
}

function AgentPanel({p,t,index}:{p:Product;t:number;index:number}) {
  const prepared=index===0?4.55:3.35;
  const approve=index===0?5.9:5.1;
  const done=t>approve+.35;
  const count=Math.round(p.request.length*prog(t,.25,index===0?2.8:2.0,ease.linear));
  const move=prog(t,approve-.65,approve,ease.pointer);
  return <div style={{position:'absolute',top:88,right:0,bottom:0,width:657,borderLeft:`1px solid ${p.line}`,padding:'31px 34px'}}>
    <div style={{display:'flex',alignItems:'center',gap:15,fontSize:27,fontWeight:500,marginBottom:30}}><Spark color={p.accent}/>{p.name} assistant</div>
    <div style={{minHeight:154,padding:'23px 26px',background:p.bubble,borderRadius:'20px 20px 4px 20px',fontSize:32,lineHeight:1.33,letterSpacing:'-.025em'}}>{p.request.slice(0,count)}<span style={{opacity:t<3?1:0}}>▎</span></div>
    <div style={{marginTop:25,...rise(t,prepared)}}>
      <div style={{fontSize:22,fontFamily:F.mono,color:p.muted,marginBottom:15}}>{done?'✓ Complete':'Ready for your approval'}</div>
      <div style={{fontSize:30,lineHeight:1.35,letterSpacing:'-.02em',minHeight:86}}>{done?p.completed:[<>3 new times found.<br/>Messages drafted.</>,<>Return label ready.<br/>Send it to Maya?</>,<>3 tasks, owners, and dates.<br/>Ready to create?</>][index]}</div>
      <div style={{marginTop:18,width:520,height:67,display:'flex',justifyContent:'center',alignItems:'center',borderRadius:14,background:done?p.bubble:p.accent,color:done?p.ink:p.bg,fontSize:25,fontWeight:600,transform:`scale(${t>approve&&t<approve+.13?.975:1})`}}>{done?'✓ Done':p.action}</div>
    </div>
    {t>approve-.65&&t<approve+.55&&<Pointer x={565-260*move} y={605-148*move} click={t>=approve&&t<approve+.16}/>}
  </div>;
}

function ProductScene({t,index}:{t:number;index:number}) {
  const p=products[index];
  const local=t-[timeline.booking,timeline.store,timeline.projects][index];
  const len=[8.2,7,7][index];
  const enter=reveal(local);
  const exit=prog(local,len-.27,len,ease.inOut);
  const done=local>(index===0?6.25:5.45);
  return <AbsoluteFill style={{opacity:enter*(1-exit)}}>
    <div style={{position:'absolute',left:116,top:162,fontSize:49,fontWeight:500,letterSpacing:'-.035em'}}>{p.kind}<span style={{color:B.muted}}>. Your agent.</span></div>
    <div style={{position:'absolute',right:119,top:175,fontFamily:F.mono,fontSize:24,color:B.muted}}>{p.number} / 03</div>
    <div style={{position:'absolute',left:108,top:260,width:1704,height:686,background:p.bg,color:p.ink,borderRadius:26,overflow:'hidden',border:`1px solid ${p.line}`,boxShadow:'0 25px 65px #11131115',transform:`translateY(${18*(1-enter)}px) scale(${.99+.01*enter})`}}>
      <div style={{height:88,display:'flex',alignItems:'center',padding:'0 39px',borderBottom:`1px solid ${p.line}`}}><div style={{fontSize:42,fontWeight:600,letterSpacing:'-.06em'}}>{p.name}<span style={{color:p.accent}}>.</span></div><div style={{marginLeft:60,fontSize:24,color:p.muted}}>{['Calendar','Orders','Projects'][index]}</div><div style={{marginLeft:'auto',fontSize:22,color:p.muted}}>Acme team</div></div>
      <div style={{position:'absolute',left:42,top:130,width:927}}>
        {index===0?<Calendar p={p} t={local} approved={done}/>:index===1?<Order p={p} approved={done}/>:<Projects p={p} t={local} approved={done}/>}
      </div>
      <AgentPanel p={p} t={local} index={index}/>
    </div>
  </AbsoluteFill>;
}

function Connections({t}:{t:number}) {
  const local=t-timeline.connection;
  const v=reveal(local)*(1-prog(t,38.7,39,ease.inOut));
  const tool=reveal(local,5.1);
  return <AbsoluteFill style={{opacity:v}}>
    <div style={{position:'absolute',left:116,top:200,fontSize:87,lineHeight:1.1,letterSpacing:'-.04em',fontWeight:500}}>Different products.</div>
    <div style={{position:'absolute',left:116,top:300,fontSize:107,lineHeight:1.05,letterSpacing:'-.03em',...serif,...rise(local,.75)}}>Unmistakably yours.</div>
    <svg style={{position:'absolute',left:0,top:0}} width="1920" height="1080" viewBox="0 0 1920 1080"><path d="M399 659H960M960 659H1521M960 659V842" fill="none" stroke={B.teal} strokeWidth="2" strokeDasharray="5 10" opacity={.42*reveal(local,1.1)}/></svg>
    {products.map((p,i)=><div key={p.name} style={{position:'absolute',left:116+i*562,top:514,width:518,height:210,borderRadius:26,background:p.bg,color:p.ink,padding:36,boxShadow:'0 18px 45px #11131110',...rise(local,.2+i*.16)}}>
      <div style={{fontSize:43,fontWeight:600,letterSpacing:'-.05em'}}>{p.name}.</div><div style={{display:'flex',alignItems:'center',gap:15,marginTop:26,fontSize:25,color:p.muted}}><Spark color={p.accent} size={26}/>Your own agent.</div>
    </div>)}
    <div style={{position:'absolute',left:637,top:803,width:646,height:95,background:B.bg,border:`1px solid ${B.line}`,borderRadius:21,display:'flex',justifyContent:'center',alignItems:'center',gap:24,boxShadow:'0 15px 40px #1113110c',...rise(local,2.8)}}><OpenGeniMark size={48} color={B.ink}/><span style={{fontSize:33,fontWeight:500}}>Powered by OpenGeni</span></div>
    <div style={{position:'absolute',left:116,top:959,width:1688,display:'flex',justifyContent:'space-between',fontSize:29,color:B.muted,opacity:tool}}><span>Your tools, connected.</span><span>Your users, in control.</span></div>
  </AbsoluteFill>;
}

function Closing({t}:{t:number}) {
  const local=t-timeline.ending;
  return <AbsoluteFill>
    <div style={{position:'absolute',left:116,top:182,fontSize:134,fontWeight:500,letterSpacing:'-.052em',lineHeight:1.05,...rise(local)}}>Give your users</div>
    <div style={{position:'absolute',left:116,top:330,fontSize:182,lineHeight:1.1,letterSpacing:'-.045em',...serif,...rise(local,.35)}}>an agent.</div>
    <div style={{position:'absolute',left:123,top:610,fontSize:50,letterSpacing:'-.03em',...rise(local,1.15)}}>Your app. Your brand. Your tools.</div>
    <div style={{position:'absolute',left:116,top:836,...rise(local,1.7)}}><OpenGeniWordmark height={66} color={B.ink}/></div>
    <div style={{position:'absolute',right:123,top:855,fontSize:40,letterSpacing:'-.025em',...rise(local,1.7)}}>opengeni.ai</div>
  </AbsoluteFill>;
}

/** Authored illustrative product interactions, not recordings or live tool runs.
 * Spoken customer requests are voiceover, not a claim about built-in voice I/O.
 * Every protected action waits for an explicit illustrated approval click. */
export const InsideProduct:React.FC<{withAudio?:boolean}>=({withAudio=true})=>{
  const t=useCurrentFrame()/timeline.fps;
  const [handle]=useState(()=>delayRender('inside-product fonts'));
  useEffect(()=>{fontsReady.then(()=>continueRender(handle));},[handle]);
  return <AbsoluteFill style={{overflow:'hidden',fontFamily:F.brandSans,color:B.ink}}>
    <Backdrop t={t}/><Masthead t={t}/>
    {t<timeline.booking&&<Intro t={t}/>}
    {t>=timeline.booking&&t<timeline.store&&<ProductScene t={t} index={0}/>}
    {t>=timeline.store&&t<timeline.projects&&<ProductScene t={t} index={1}/>}
    {t>=timeline.projects&&t<timeline.connection&&<ProductScene t={t} index={2}/>}
    {t>=timeline.connection&&t<timeline.ending&&<Connections t={t}/>}
    {t>=timeline.ending&&<Closing t={t}/>}
    {withAudio&&<Audio src={staticFile('audio/inside-product/mix.wav')}/>}
  </AbsoluteFill>;
};
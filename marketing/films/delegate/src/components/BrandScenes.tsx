import React from "react";
import { staticFile } from "remotion";
import { B } from "../theme";
import { F } from "../fonts";
import { ease, lerp, prog } from "../anim";
import { T } from "../timeline";
import { OpenGeniWordmark } from "./OpenGeniWordmark";
import { CursorArrow, flopPose } from "./Cursor";

/** Same continuous light field as the new identity film; no scene resets. */
export const BrandBackdrop: React.FC<{t:number}> = ({t}) => (
  <div style={{position:"absolute",inset:0,background:B.bg}}>
    <div style={{position:"absolute",inset:0,opacity:.58 + .35 * prog(t,0,T.end),background:
      "radial-gradient(ellipse 86% 110% at 100% 0%, #ffb787 0%, #ffb787b3 26%, #ffb78700 74%), radial-gradient(ellipse 86% 110% at 0% 100%, #9fe3d3 0%, #9fe3d3b3 26%, #9fe3d300 74%)"}}/>
  </div>
);

const appear = (t:number, at:number) => prog(t,at,at+.36,ease.out);
const serif: React.CSSProperties = {fontFamily:F.serif,fontWeight:400,fontStyle:"italic",letterSpacing:"-.025em"};

export const BrandScenes: React.FC<{t:number}> = ({t}) => {
  if(t < T.wipe) return null;
  return <div style={{position:"absolute",inset:0,color:B.ink,fontFamily:F.brandSans}}>
    {t < T.ann2+.15 && <Bridge t={t}/>}
    {t >= T.ann2-.15 && t < T.line1 && <CodeSpread t={t}/>}
    {t >= T.line1 && <EndCard t={t}/>}
  </div>;
};

const Bridge: React.FC<{t:number}> = ({t}) => {
  const v=appear(t,T.wipe+.2)*(1-prog(t,T.ann2-.22,T.ann2+.14));
  const reveal=appear(t,T.ann1-.3);
  return <div style={{position:"absolute",inset:0,opacity:v}}>
    <div style={{position:"absolute",left:120,top:286,width:830,height:467,borderRadius:24,overflow:"hidden",boxShadow:"0 28px 64px #11131120",border:"1px solid #ffffffb3"}}>
      <img src={staticFile("stills/hour-result.png")} alt="Result in hour" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
    </div>
    <div style={{position:"absolute",left:1040,top:285,width:760}}>
      <div style={{fontSize:50,fontWeight:500,letterSpacing:"-.035em"}}>hour is a booking app.</div>
      <div style={{marginTop:65,opacity:reveal,transform:`translateY(${(1-reveal)*16}px)`}}>
        <OpenGeniWordmark height={64} color={B.ink}/>
        <div style={{marginTop:32,fontSize:68,lineHeight:1.06,...serif}}>powers the<br/>agent inside.</div>
      </div>
    </div>
  </div>;
};

/** Selected integration surfaces, not a complete setup tutorial. RECUT.md
 * retains the omitted auth, provider and protected endpoint context. */
const CODE = [
  "const session = await og.createSession(",
  "  workspaceId, { initialMessage: text,",
  "    mcpServers: [hourTools],",
  '    tools: [{ kind: "mcp", id: "hour" }],',
  "  });",
  "// inside hour's UI",
  "<SessionConversation sessionId={session.id} />",
];

const CodeSpread: React.FC<{t:number}> = ({t}) => {
  const v=appear(t,T.ann2-.1);
  const ui=t >= T.ann3;
  const at=ui?T.ann3:T.ann2;
  const p=appear(t,at);
  return <div style={{position:"absolute",inset:0,opacity:v}}>
    <div style={{position:"absolute",left:110,top:222,width:1120,height:630,background:"#ffffffd9",border:`1px solid ${B.line}`,borderRadius:26,boxShadow:"0 26px 65px #11131112",overflow:"hidden"}}>
      <div style={{height:76,display:"flex",alignItems:"center",padding:"0 38px",borderBottom:`1px solid ${B.line}`,fontFamily:F.mono,fontSize:25,color:B.muted}}>hour / agent.tsx</div>
      <div style={{padding:"29px 0",fontFamily:F.mono,fontSize:35,lineHeight:"69px",letterSpacing:"-.035em"}}>
        {CODE.map((line,i)=> {
          const active=ui?i===6:i===2||i===3;
          return <div key={i} style={{height:69,padding:"0 36px",whiteSpace:"pre",background:active?"#9fe3d354":"transparent",borderLeft:`4px solid ${active?B.teal:"transparent"}`,color:i===5?B.muted:B.ink,opacity:active?1:.67}}>{line}</div>;
        })}
      </div>
    </div>
    <div style={{position:"absolute",left:1320,top:344,width:500,opacity:p,transform:`translateY(${(1-p)*12}px)`}}>
      <div style={{fontSize:62,lineHeight:1.08,letterSpacing:"-.04em",fontWeight:500}}>{ui?"Put it inside":"Give it your"}</div>
      <div style={{fontSize:76,lineHeight:1.1,...serif}}>{ui?"your app.":"app’s actions."}</div>
      <div style={{marginTop:46,padding:"21px 24px",background:"#ffffffab",border:`1px solid ${B.line}`,borderRadius:18,fontSize:30,lineHeight:1.35}}>
        {ui?<><span style={{color:B.teal}}>✓</span> A conversation in hour</>:<><span style={{color:B.teal}}>✓</span> Ben moved to Thu 5:00</>}
      </div>
    </div>
  </div>;
};

const EndCard: React.FC<{t:number}> = ({t}) => {
  const first=appear(t,T.line1), second=appear(t,T.line2), mark=appear(t,T.mark);
  return <div style={{position:"absolute",inset:0}}>
    <div style={{position:"absolute",left:150,top:178,fontSize:116,fontWeight:500,letterSpacing:"-.045em",lineHeight:1.06,opacity:first,transform:`translateY(${(1-first)*20}px)`}}>Give your users</div>
    <div style={{position:"absolute",left:150,top:302,fontSize:148,lineHeight:1.08,...serif,opacity:second,transform:`translateY(${(1-second)*20}px)`}}>an agent.<RestingCursor t={t}/></div>
    <div style={{position:"absolute",left:155,top:539,fontSize:44,letterSpacing:"-.025em",opacity:mark}}>Your app. Your brand. Your tools.</div>
    <div style={{position:"absolute",left:150,top:742,opacity:mark}}><OpenGeniWordmark height={69} color={B.ink}/></div>
    <div style={{position:"absolute",right:150,top:757,fontSize:40,letterSpacing:"-.02em",opacity:mark}}>opengeni.ai</div>
    <div style={{position:"absolute",left:155,top:870,fontSize:31,color:B.muted,opacity:mark}}>Apache-2.0 · Managed or self-hosted</div>
  </div>;
};

const RestingCursor: React.FC<{t:number}> = ({t}) => {
  if(t<T.restIn) return null;
  const k=prog(t,T.restIn,T.restFlop-.02,ease.pointer);
  return <span style={{position:"relative",display:"inline-block",width:0,height:0,verticalAlign:"baseline"}}>
    <span style={{position:"absolute",left:lerp(520,24,k),top:lerp(420,-48,k)}}><CursorArrow pose={flopPose(t,T.restFlop)} scale={1.5}/></span>
  </span>;
};
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
mkdirSync(resolve(root,'out'),{recursive:true});
const timeline=JSON.parse(readFileSync(resolve(root,'src/inside-product-timeline.json'),'utf8'));
const folder=resolve(root,'public/audio/inside-product');
const cues=timeline.voices;
const filters=[];
const args=['-hide_banner','-y'];
for(const cue of cues) args.push('-i',resolve(folder,`${cue.id}.mp3`));
args.push('-i',resolve(folder,'score.mp3'));
for(const [i,cue] of cues.entries()) {
  filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,volume=1.2,adelay=${Math.round(cue.start*1000)}:all=1[a${i}]`);
}
filters.push(`${cues.map((_,i)=>`[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,apad,atrim=duration=${timeline.duration},asplit=2[vo][side]`);
filters.push(`[${cues.length}:a]aresample=48000,volume=0.22,afade=t=in:st=0:d=0.5,afade=t=out:st=45:d=3[music]`);
filters.push('[music][side]sidechaincompress=threshold=0.025:ratio=6:attack=18:release=350:makeup=1[ducked]');
// Two quiet original tones create a repeatable approval/closing signature.
filters.push('sine=frequency=880:duration=0.10:sample_rate=48000,afade=t=out:d=0.10,volume=0.04,adelay=11700:all=1,pan=stereo|c0=c0|c1=c0[tick1]');
filters.push('sine=frequency=1108.73:duration=0.12:sample_rate=48000,afade=t=out:d=0.12,volume=0.035,adelay=19400:all=1,pan=stereo|c0=c0|c1=c0[tick2]');
filters.push('sine=frequency=1318.51:duration=0.14:sample_rate=48000,afade=t=out:d=0.14,volume=0.03,adelay=26400:all=1,pan=stereo|c0=c0|c1=c0[tick3]');
filters.push('[vo][ducked][tick1][tick2][tick3]amix=inputs=5:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000,atrim=duration=48[out]');
args.push('-filter_complex',filters.join(';'),'-map','[out]','-c:a','pcm_s24le',resolve(folder,'mix.wav'));
const r=spawnSync('ffmpeg',args,{stdio:'inherit'});
if(r.status!==0) process.exit(r.status??1);
const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',resolve(folder,'mix.wav')],{encoding:'utf8'});
const duration=Number(JSON.parse(probe.stdout).format.duration);
if(Math.abs(duration-timeline.duration)>0.1) throw new Error(`Mix is ${duration}s, expected ${timeline.duration}s`);
const stamp=(s)=>{const ms=Math.round(s*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
const segments=[];
for (const cue of cues) {
  const receipt=JSON.parse(readFileSync(resolve(root,`audio/inside-product/receipts/${cue.id}.json`),'utf8'));
  if(receipt.status!=='completed') throw new Error('Missing audio completion receipt');
  // Caption boundaries use generated clip duration, not guessed narration pace.
  const lines=cue.text.match(/[^.!?]+[.!?]+/g)??[cue.text];
  const weights=lines.map(x=>x.trim().split(/\s+/).length);
  const total=weights.reduce((s,x)=>s+x,0);
  let at=cue.start;
  for(const [i,line] of lines.entries()) {
    const end=at+receipt.durationSeconds*weights[i]/total;
    segments.push(`${segments.length+1}\n${stamp(at)} --> ${stamp(end)}\n${line.trim()}\n`);
    at=end;
  }
}
writeFileSync(resolve(root,'out/inside-your-product.srt'),segments.join('\n'));
console.log('Mixed 48-second score with speech ducking; wrote approximate sentence captions.');
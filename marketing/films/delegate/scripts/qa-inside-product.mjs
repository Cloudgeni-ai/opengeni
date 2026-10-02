import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const timeline=JSON.parse(readFileSync(resolve(root,'src/inside-product-timeline.json'),'utf8'));
const manifest=JSON.parse(readFileSync(resolve(root,'audio/inside-product/manifest.json'),'utf8'));
assert(manifest.jobs.reduce((s,j)=>s+j.reserveUsd,0)<=50,'Conservative generation reserve must stay within user cap');
let speechUnits=0;
for(const job of manifest.jobs) {
  const r=JSON.parse(readFileSync(resolve(root,`audio/inside-product/receipts/${job.id}.json`),'utf8'));
  assert.equal(r.status,'completed',`${job.id} incomplete; do not replay automatically`);
  assert.equal(r.httpStatus,200);
  assert(r.durationSeconds>0);
  speechUnits+=Number(r.provider?.['character-cost']??0);
}
for(let i=0;i<timeline.voices.length;i++) {
  const cue=timeline.voices[i];
  const r=JSON.parse(readFileSync(resolve(root,`audio/inside-product/receipts/${cue.id}.json`),'utf8'));
  const next=timeline.voices[i+1]?.start??timeline.duration;
  assert(cue.start+r.durationSeconds<=next,`Voice overlap: ${cue.id}`);
}
const path=resolve(root,process.argv[2]??'public/audio/inside-product/mix.wav');
assert(existsSync(path));
const probe=spawnSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path],{encoding:'utf8'});
assert.equal(probe.status,0);
const info=JSON.parse(probe.stdout);
assert(Math.abs(Number(info.format.duration)-48)<.15,'Media must be 48 seconds');
const audio=info.streams.find(s=>s.codec_type==='audio');
assert(audio,'Audio missing');
assert.equal(Number(audio.sample_rate),48000);
assert.equal(audio.channels,2);
const video=info.streams.find(s=>s.codec_type==='video');
if(video) {
  assert.equal(video.width,1920);assert.equal(video.height,1080);
  assert.equal(video.codec_name,'h264');assert.equal(video.pix_fmt,'yuv420p');
  assert.equal(video.r_frame_rate,'30/1');
}
const decode=spawnSync('ffmpeg',['-v','error','-i',path,'-f','null','-'],{encoding:'utf8'});
assert.equal(decode.status,0,decode.stderr);
assert.equal(decode.stderr.trim(),'','Decode emitted an error');
const loudness=spawnSync('ffmpeg',['-hide_banner','-nostats','-i',path,'-af','loudnorm=I=-16:TP=-1.5:LRA=9:print_format=json','-f','null','-'],{encoding:'utf8'});
assert.equal(loudness.status,0);
const match=loudness.stderr.match(/\{\s*"input_i"[\s\S]*?\}/);
assert(match,'Missing loudness measurements');
const measured=JSON.parse(match[0]);
assert(Number(measured.input_tp)<-.8,'Insufficient true-peak headroom');
assert(Number(measured.input_i)>-20&&Number(measured.input_i)<-13,'Unexpected integrated loudness');
console.log(JSON.stringify({result:'PASS',path,duration:info.format.duration,resolution:video?'1920x1080 at 30 fps':null,loudness:measured.input_i,truePeak:measured.input_tp,speechProviderCharacterCostUnits:speechUnits,reserveUsd:manifest.jobs.reduce((s,j)=>s+j.reserveUsd,0),billing:'Reserves are not actual charges. API key cannot read billing; music response gives no cost. Exact account invoice not verified.',captions:'Approximate sentence timing based on actual clip durations, not forced-aligned.',verification:'Decode, timing and loudness verified. No human listening review is implied.'},null,2));
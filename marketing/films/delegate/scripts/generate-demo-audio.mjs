import {readFileSync, writeFileSync, mkdirSync, existsSync, statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

// One explicit POST per invocation. No retries, including after an unknown result.
// The key exists only in process memory and curl stdin, never in a file or argv.
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'audio/inside-product/manifest.json'), 'utf8'));
const id = process.argv[2];
const job = manifest.jobs.find((j) => j.id === id);
if (!job) throw new Error('Choose one manifest job: ' + manifest.jobs.map((j) => j.id).join(', '));
const dir = resolve(root, 'audio/inside-product/receipts');
const dest = resolve(root, 'public/audio/inside-product');
mkdirSync(dir, {recursive:true});
mkdirSync(dest, {recursive:true});
const receiptFile = resolve(dir, `${id}.json`);
if (existsSync(receiptFile)) throw new Error(`Receipt already exists for ${id}; inspect it, never replay this generation.`);
const reserved = manifest.jobs.reduce((s,j) => s + j.reserveUsd, 0);
if (reserved > manifest.budgetUsd) throw new Error('Manifest exceeds the authorized total budget');
const key = process.env.ELEVEN_DEMO_KEY;
if (!key) throw new Error('ELEVEN_DEMO_KEY is required in the process environment');
const bodyPath = resolve(dir, `${id}.request.json`);
const headerPath = resolve(dir, `${id}.response-headers.txt`);
const output = resolve(dest, `${id}.mp3`);
writeFileSync(bodyPath, JSON.stringify(job.body, null, 2));
const receipt = {id, status:'submitted-outcome-unknown', submittedAt:new Date().toISOString(), reserveUsd:job.reserveUsd, output, model:job.body.model_id};
writeFileSync(receiptFile, JSON.stringify(receipt, null, 2), {flag:'wx'});
console.log(`Submitting ${id}; reserved $${job.reserveUsd}; plan reserve $${reserved}/$${manifest.budgetUsd}.`);
const endpoint = job.kind === 'speech' ? '/v1/text-to-dialogue?output_format=mp3_44100_128' : '/v1/music';
const result = spawnSync('curl', ['--silent','--show-error','--max-time','180','--connect-timeout','15',
  '--request','POST','--header','@-','--data-binary',`@${bodyPath}`,
  '--dump-header',headerPath,'--output',output,'--write-out','%{http_code}',
  `https://api.elevenlabs.io${endpoint}`], {
  input:`xi-api-key: ${key}\nContent-Type: application/json\n`, encoding:'utf8', maxBuffer:1024*1024,
});
receipt.httpStatus = Number(result.stdout);
receipt.curlExit = result.status;
const headers = existsSync(headerPath) ? readFileSync(headerPath, 'utf8') : '';
receipt.provider = Object.fromEntries(headers.split(/\r?\n/).flatMap(line => {
  const i=line.indexOf(':'); if(i<0) return [];
  const name=line.slice(0,i).toLowerCase();
  return /^(request-id|x-request-id|x-trace-id|character-cost|x-character-cost|credits-spent|content-type)$/.test(name)
    ? [[name,line.slice(i+1).trim()]] : [];
}));
receipt.bytes = existsSync(output) ? statSync(output).size : 0;
if(result.status === 0 && receipt.httpStatus === 200) {
  const check=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',output],{encoding:'utf8'});
  receipt.status=check.status===0 ? 'completed' : 'response-not-valid-audio';
  if(check.status===0) receipt.durationSeconds=Number(JSON.parse(check.stdout).format.duration);
} else {
  receipt.status = receipt.httpStatus >= 400 ? 'provider-rejected' : 'submitted-outcome-unknown';
  if(receipt.bytes < 20000 && existsSync(output)) {
    try {receipt.error=JSON.parse(readFileSync(output,'utf8'));} catch {}
  }
}
writeFileSync(receiptFile, JSON.stringify(receipt,null,2));
console.log(JSON.stringify(receipt,null,2));
if(receipt.status!=='completed') process.exitCode=1;
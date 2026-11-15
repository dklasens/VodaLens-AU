'use strict';
// Bounded, read-only UI/session check on the USB Pixel. Never reads credentials.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = require('node:path').resolve(__dirname, '..');
function adb(args) {
  const result = spawnSync('adb', args, { encoding:'utf8', timeout:30000 });
  if(result.status !== 0) throw new Error('ADB verification step failed.');
  return result.stdout;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function ui(name) {
  const file = `/sdcard/${name}.xml`;
  const result = adb(['shell','uiautomator','dump',file]);
  if(!result.includes('UI hierchary dumped to:')) throw new Error('A fresh app UI could not be captured.');
  return adb(['exec-out','cat',file]);
}
(async () => {
  const before = ui('vodalens-foreground-before');
  if(!before.includes('content-desc="Refresh Vodafone data"')) throw new Error('Wait for the app to finish syncing before this check.');
  const beforeTime = [...before.matchAll(/text="(Last refreshed[^\"]*)"/g)].map(m=>m[1]);
  const pid = adb(['shell','pidof','au.com.vodalens']).trim();
  const startedAt = Date.now();
  const dueAt = startedAt + 330000;
  adb(['shell','input','keyevent','KEYCODE_HOME']);
  console.log(JSON.stringify({state:'background_wait',startedAt:new Date(startedAt).toISOString(),resumeAt:new Date(dueAt).toISOString(),processConfirmed:!!pid}));
  await sleep(Math.max(0,dueAt-Date.now()));
  const pidBeforeResume = adb(['shell','pidof','au.com.vodalens']).trim();
  const focus = adb(['shell','dumpsys','window']);
  const wasBackground = !/mCurrentFocus=.*au\.com\.vodalens/.test(focus);
  adb(['shell','am','start','-n','au.com.vodalens/.MainActivity']);
  console.log(JSON.stringify({state:'resumed',sameProcess:pid===pidBeforeResume,wasBackground}));
  let after;
  for(let i=0;i<8;i++) {
    await sleep(5000);
    after = ui(`vodalens-foreground-after-${i}`);
    if(after.includes('content-desc="Refresh Vodafone data"')) break;
  }
  const afterTime = [...after.matchAll(/text="(Last refreshed[^\"]*)"/g)].map(m=>m[1]);
  const logs = adb(['logcat','-d','-s','VodaLensSession:W','*:S']);
  const events = logs.split('\n').filter(line=>line.includes('VodaLensSession') && (line.includes('Renewal accepted:') || line.includes('Renewal rejected:'))).map(line=>({time:line.slice(0,18).trim(),accepted:line.includes('Renewal accepted:'),previousExpired:line.includes('previousExpired=true'),rotated:line.includes('rotated=true'),lifetimeSeconds:line.match(/lifetimeSeconds=(\d+)/)?.[1] ? Number(line.match(/lifetimeSeconds=(\d+)/)[1]) : null, httpStatus:line.match(/http=(\d+)/)?.[1] ? Number(line.match(/http=(\d+)/)[1]) : null,code:line.match(/code=([a-z_]+)/)?.[1] || null,category:line.match(/category=([a-z_]+)/)?.[1] || null}));
  const result = {state:'complete',startedAt:new Date(startedAt).toISOString(),resumedAt:new Date(dueAt).toISOString(),finishedAt:new Date().toISOString(),backgroundSeconds:330,sameProcess:pid===pidBeforeResume,wasBackground,beforeRefreshLabels:beforeTime,afterRefreshLabels:afterTime,timestampAdvanced:afterTime.length>0 && JSON.stringify(afterTime)!==JSON.stringify(beforeTime),noReconnect:!after.includes('text="Reconnect"'),idleAfterSync:after.includes('content-desc="Refresh Vodafone data"'),sessionEvents:events,credentialsIncluded:false};
  result.passed = result.sameProcess && result.wasBackground && result.timestampAdvanced && result.noReconnect && result.idleAfterSync && events.some(e=>e.accepted && e.previousExpired && e.rotated);
  fs.writeFileSync(`${root}/local-data/android-foreground-verification.json`,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
})().catch(()=> { console.error('Foreground verification could not complete; inspect the device state before retrying.'); process.exitCode=1; });

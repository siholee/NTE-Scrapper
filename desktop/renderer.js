const $ = id => document.getElementById(id);
const active = new Set(['queued', 'discovering', 'running', 'exporting', 'cancelling']);
let current, busy = false;
function render(job) {
  if (!job) return;
  current = job;
  $('title').textContent = job.title || '목록 확인 중'; $('count').textContent = job.total ? `${job.completed} / ${job.total}` : '';
  $('progress').max = job.total || 1; $('progress').value = job.completed;
  $('message').textContent = job.status === 'waiting' ? '브라우저에서 인증 또는 본문 로딩을 확인한 뒤 계속을 누르세요.' : job.status === 'failed' ? job.error : job.status === 'completed' ? '전체 TXT와 EPUB 저장이 완료됐습니다.' : job.message;
  $('start').disabled = active.has(job.status) || job.status === 'waiting';
  $('stop').hidden = !active.has(job.status) && job.status !== 'waiting';
  $('resume').hidden = !['waiting','failed','cancelled','interrupted'].includes(job.status);
  const drive = job.status === 'completed' ? job.drive : null;
  $('drive-message').hidden = !drive;
  $('drive-message').textContent = drive?.status === 'copied'
    ? `Google Drive 동기화 폴더에 복사됨 · ${drive.path}`
    : drive?.error ? `Google Drive 동기화 폴더에 복사하지 못했습니다. (${drive.error})` : '';
  $('drive-retry').hidden = drive?.status !== 'failed';
}
async function invoke(operation) {
  try { const r = await operation(); if (!r.ok) throw new Error(r.error); render(r.value); } catch (e) { $('message').textContent = e.message; }
}
$('form').addEventListener('submit', async event => { event.preventDefault(); $('start').disabled = true; await invoke(() => window.nte.start($('url').value.trim(), $('delay').valueAsNumber)); $('start').disabled = !!current && (active.has(current.status) || current.status === 'waiting'); });
$('resume').onclick = () => current && invoke(() => window.nte.resume(current.jobId));
$('stop').onclick = () => current && invoke(() => window.nte.cancel(current.jobId));
$('folder').onclick = () => window.nte.folder();
async function driveSettings(operation) {
  try {
    const result = await operation();
    if (!result.ok) throw new Error(result.error);
    const folder = result.value.folder;
    $('drive-folder').textContent = folder || '선택하면 새 작업의 EPUB을 Google Drive for desktop 동기화 폴더에 복사합니다.';
    $('drive-clear').hidden = !folder;
  } catch (error) {
    $('drive-folder').textContent = error.message;
  }
}
$('drive-select').onclick = () => driveSettings(window.nte.driveSelect);
$('drive-clear').onclick = () => driveSettings(window.nte.driveClear);
$('drive-retry').onclick = async () => {
  const button = $('drive-retry');
  button.disabled = true;
  try {
    const result = await window.nte.driveRetry(current.jobId);
    if (!result.ok) throw new Error(result.error);
    render(result.value);
  } catch (error) {
    $('drive-message').textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
driveSettings(window.nte.driveSettings);
async function refresh() { if (busy) return; busy = true; try { const r = await window.nte.status(); if (!r.ok) throw new Error(r.error); const jobs = r.value.jobs; const job = jobs.find(j => j.jobId === r.value.activeJobId) || jobs.find(j => j.jobId === current?.jobId) || jobs[0]; if (job) { render(job); if (!$('url').value) $('url').value = job.url; } } catch (e) { $('message').textContent = e.message; } finally { busy = false; } }
refresh(); setInterval(refresh, 1000);

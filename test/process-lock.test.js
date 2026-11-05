import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesWorker } from '../src/process-lock.js';
const worker = 'C:\\Tools\\NTE Scrapper\\src\\worker.js';
test('reused Windows service PID does not retain an NTE lock', () => {
  assert.equal(matchesWorker({name:'svchost.exe',commandLine:null},worker), false);
  assert.equal(matchesWorker({name:'svchost.exe',commandLine:'C:\\Windows\\system32\\svchost.exe -k netsvcs'},worker), false);
});
test('only the matching Node worker retains its lock', () => {
  assert.equal(matchesWorker({name:'node.exe',commandLine:`node.exe "${worker}"`},worker),true);
  assert.equal(matchesWorker({name:'NODE.EXE',commandLine:`node.exe "${worker.replaceAll('\\','/').toUpperCase()}"`},worker),true);
  assert.equal(matchesWorker({name:'node.exe',commandLine:'node.exe C:\\other\\server.js'},worker),false);
});
test('unknown Node identity stays conservative; missing process releases lock', () => {
  assert.equal(matchesWorker({name:'node.exe',commandLine:null},worker),true);
  assert.equal(matchesWorker(null,worker),false);
});

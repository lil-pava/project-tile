// Checks the macOS and Linux process-table parsing: node --test scripts/ps.check.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cpuSeconds, parsePs } from './collect.mjs'

test('cpu time in the Linux and macOS formats', () => {
  assert.equal(cpuSeconds('00:02:40'), 160) // Linux HH:MM:SS
  assert.equal(cpuSeconds('2-01:00:05'), 2 * 86400 + 3605) // Linux with days
  assert.equal(cpuSeconds('0:02.35'), 2.35) // macOS M:SS.ss
  assert.equal(cpuSeconds('123:45.50'), 123 * 60 + 45.5) // macOS past an hour
})

test('Linux ps output (procps)', () => {
  const main = [
    '      1       0 00:00:02 Mon Nov 16 00:29:57 2026 /sbin/init',
    '   4210    4100 00:01:10 Mon Nov  6 09:05:01 2026 /usr/local/Wolfram/Wolfram/14.2/Executables/WolframKernel -run PacletSymbol["Wolfram/AgentTools","StartMCPServer"][]',
    '   4100    3900 00:00:12 Mon Nov  6 09:05:00 2026 /home/me/.local/bin/claude --resume abc',
  ].join('\n')
  const names = ['      1 systemd', '   4210 WolframKernel', '   4100 claude'].join('\n')
  const procs = parsePs(main, names)
  assert.equal(procs.length, 3)
  const kernel = procs.find(p => p.pid === 4210)
  assert.equal(kernel.ppid, 4100)
  assert.equal(kernel.cpu, 70)
  assert.equal(kernel.name, 'wolframkernel')
  assert.equal(kernel.start, 'Mon Nov  6 09:05:01 2026')
  assert.match(kernel.cmd, /StartMCPServer/)
})

test('macOS ps output (comm is a full path, maybe with spaces)', () => {
  const main = [
    '  812     1   0:41.07 Mon Nov 16 08:01:12 2026 /Applications/Claude.app/Contents/MacOS/Claude',
    '  930   812   1:02.50 Mon Nov 16 08:02:00 2026 /Applications/Wolfram.app/Contents/MacOS/WolframKernel -subkernel -noinit',
    '  901   812   0:03.00 Mon Nov 16 08:01:30 2026 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility',
  ].join('\n')
  const names = [
    '  812 /Applications/Claude.app/Contents/MacOS/Claude',
    '  930 /Applications/Wolfram.app/Contents/MacOS/WolframKernel',
    '  901 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper',
  ].join('\n')
  const procs = parsePs(main, names)
  assert.deepEqual(
    procs.map(p => [p.pid, p.name, p.cpu]),
    [
      [812, 'claude', 41.07],
      [930, 'wolframkernel', 62.5],
      [901, 'claude helper', 3],
    ],
  )
  assert.match(procs[1].cmd, /-subkernel/)
})

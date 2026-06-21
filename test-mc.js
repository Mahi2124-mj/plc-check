'use strict';
// Offline self-test for lib/mc.js frame builder. No PLC required.  Run: node test-mc.js
const mc = require('./lib/mc');

const hex = (b) => b.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ');

const cases = [
    ['3E read  D0 x1',        { frame: '3E', device: 'D', address: '0', count: 1, mode: 'read' },
        '50 00 00 FF FF 03 00 0C 00 10 00 01 04 00 00 00 00 00 A8 01 00'],
    ['4E read  D0 x1 (ser1)', { frame: '4E', device: 'D', address: '0', count: 1, mode: 'read' },
        '54 00 01 00 00 00 00 FF FF 03 00 0C 00 10 00 01 04 00 00 00 00 00 A8 01 00'],
    ['3E read  M0 x16 (bit)', { frame: '3E', device: 'M', address: '0', count: 16, mode: 'read' },
        '50 00 00 FF FF 03 00 0C 00 10 00 01 04 01 00 00 00 00 90 10 00'],
    ['3E write D0 [100,0x1F]', { frame: '3E', device: 'D', address: '0', mode: 'write', values: [100, 0x1F] },
        '50 00 00 FF FF 03 00 10 00 10 00 01 14 00 00 00 00 00 A8 02 00 64 00 1F 00'],
    ['3E write M0 [1,0,1] bit', { frame: '3E', device: 'M', address: '0', mode: 'write', values: [1, 0, 1] },
        '50 00 00 FF FF 03 00 0E 00 10 00 01 14 01 00 00 00 00 90 03 00 10 10']
];

let pass = 0;
for (const [name, opts, expected] of cases) {
    const got = hex(mc.buildRequest(opts).request);
    const ok = got === expected;
    if (ok) { pass++; }
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
    if (!ok) { console.log('   got     : ' + got + '\n   expected: ' + expected); }
}

// Round-trip decode check: fake a 3E reply for "read D0..D2 = 10,20,30".
const built = mc.buildRequest({ frame: '3E', device: 'D', address: '0', count: 3, mode: 'read' });
const reply = Buffer.from([0xD0, 0x00, 0x00, 0xFF, 0xFF, 0x03, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x0A, 0x00, 0x14, 0x00, 0x1E, 0x00]);
const dec = mc.parseResponse(reply, built.meta);
const decOk = dec.ok && dec.values.join(',') === '10,20,30';
if (decOk) { pass++; }
console.log((decOk ? 'PASS' : 'FAIL') + '  decode 3E read D0..D2 = 10,20,30   (got: ' + dec.values.join(',') + ')');

console.log('\n' + pass + '/' + (cases.length + 1) + ' checks passed');
process.exit(pass === cases.length + 1 ? 0 : 1);

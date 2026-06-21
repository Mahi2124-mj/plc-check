'use strict';
// Mitsubishi Q-series MC Protocol (MELSEC, binary) over TCP.
// Supports 3E and 4E frames, batch read/write in bit-units and word-units.
// Pure Node.js, no dependencies.

const net = require('net');

// Binary device codes (MELSEC / SLMP).
const DEV = {
    X:  { code: 0x9C, type: 'bit'  }, Y:  { code: 0x9D, type: 'bit'  },
    M:  { code: 0x90, type: 'bit'  }, L:  { code: 0x92, type: 'bit'  },
    F:  { code: 0x93, type: 'bit'  }, V:  { code: 0x94, type: 'bit'  },
    B:  { code: 0xA0, type: 'bit'  }, S:  { code: 0x98, type: 'bit'  },
    SM: { code: 0x91, type: 'bit'  }, SB: { code: 0xA1, type: 'bit'  },
    DX: { code: 0xA2, type: 'bit'  }, DY: { code: 0xA3, type: 'bit'  },
    TS: { code: 0xC1, type: 'bit'  }, TC: { code: 0xC0, type: 'bit'  },
    CS: { code: 0xC4, type: 'bit'  }, CC: { code: 0xC3, type: 'bit'  },
    D:  { code: 0xA8, type: 'word' }, W:  { code: 0xB4, type: 'word' },
    R:  { code: 0xAF, type: 'word' }, ZR: { code: 0xB0, type: 'word' },
    SD: { code: 0xA9, type: 'word' }, SW: { code: 0xB5, type: 'word' },
    Z:  { code: 0xCC, type: 'word' }, TN: { code: 0xC2, type: 'word' },
    CN: { code: 0xC5, type: 'word' }
};
// Devices conventionally addressed in hexadecimal.
const HEX_ADDR = { X: 1, Y: 1, B: 1, W: 1, SB: 1, SW: 1, DX: 1, DY: 1 };

let serialCounter = 0;

function parseAddress(devName, addrStr) {
    const s = String(addrStr == null ? '0' : addrStr).trim();
    let n;
    if (/^0x/i.test(s)) { n = parseInt(s, 16); }
    else if (HEX_ADDR[devName]) { n = parseInt(s, 16); }
    else { n = parseInt(s, 10); }
    if (isNaN(n) || n < 0) { throw new Error('invalid address: ' + addrStr); }
    return n;
}

function hexDump(b) {
    return b && b.length ? b.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ') : '';
}

// Build a request buffer + the meta needed to decode the reply.
// opts: { frame:'3E'|'4E', device, address, count, mode:'read'|'write', values:[] }
function buildRequest(opts) {
    const frame = (opts.frame === '4E') ? '4E' : '3E';
    const devName = String(opts.device || '').toUpperCase();
    const info = DEV[devName];
    if (!info) { throw new Error('unknown device: ' + devName); }

    const mode = (opts.mode === 'write') ? 'write' : 'read';
    const isBit = (info.type === 'bit');
    const addrNum = parseAddress(devName, opts.address);
    const values = Array.isArray(opts.values) ? opts.values : [];
    const points = (mode === 'write') ? values.length : (Number(opts.count) || 0);
    if (points < 1) { throw new Error('count / values must be >= 1'); }

    const command = (mode === 'write') ? 0x1401 : 0x0401;
    const subcommand = isBit ? 0x0001 : 0x0000;

    const devSpec = Buffer.alloc(6);
    devSpec.writeUIntLE(addrNum & 0xFFFFFF, 0, 3); // head device number (3 bytes LE)
    devSpec.writeUInt8(info.code, 3);              // device code (1 byte)
    devSpec.writeUInt16LE(points, 4);              // number of points (2 bytes LE)

    let writeData = Buffer.alloc(0);
    if (mode === 'write') {
        if (isBit) {
            writeData = Buffer.alloc(Math.ceil(values.length / 2));
            for (let i = 0; i < values.length; i++) {
                const bit = values[i] ? 1 : 0;
                const idx = Math.floor(i / 2);
                writeData[idx] |= (i % 2 === 0) ? (bit << 4) : bit; // high nibble first
            }
        } else {
            writeData = Buffer.alloc(values.length * 2);
            for (let i = 0; i < values.length; i++) {
                writeData.writeUInt16LE(values[i] & 0xFFFF, i * 2);
            }
        }
    }

    const cmd = Buffer.alloc(4);
    cmd.writeUInt16LE(command, 0);
    cmd.writeUInt16LE(subcommand, 2);
    const cmdData = Buffer.concat([cmd, devSpec, writeData]);

    const timer = Buffer.from([0x10, 0x00]); // monitoring timer: 0x0010 * 250ms = 4s
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(timer.length + cmdData.length, 0);

    let header;
    let serial = 0;
    if (frame === '4E') {
        serialCounter = (serialCounter % 0xFFFF) + 1;
        serial = serialCounter;
        header = Buffer.from([
            0x54, 0x00,                            // subheader 4E
            serial & 0xFF, (serial >> 8) & 0xFF,   // serial number
            0x00, 0x00,                            // fixed
            0x00, 0xFF, 0xFF, 0x03, 0x00           // net, PLC, I/O(0x03FF), station
        ]);
    } else {
        header = Buffer.from([
            0x50, 0x00,                            // subheader 3E
            0x00, 0xFF, 0xFF, 0x03, 0x00           // net, PLC, I/O(0x03FF), station
        ]);
    }

    const request = Buffer.concat([header, lenBuf, timer, cmdData]);
    return { request, meta: { frame, device: devName, address: String(opts.address), mode, isBit, points, serial } };
}

// How many bytes a complete reply should be, given what we have so far (0 = need more).
function expectedLen(buf, frame) {
    if (frame === '4E') { return buf.length < 13 ? 0 : 13 + buf.readUInt16LE(11); }
    return buf.length < 9 ? 0 : 9 + buf.readUInt16LE(7);
}

function parseResponse(buf, meta) {
    const out = { ok: false, status: '', text: '', values: [], completion: null, hex: hexDump(buf) };
    const minLen = (meta.frame === '4E') ? 15 : 11;
    if (!buf || buf.length < minLen) { out.status = 'short / no response'; return out; }

    const compOff = (meta.frame === '4E') ? 13 : 9;
    const comp = buf.readUInt16LE(compOff);
    out.completion = comp;
    if (comp !== 0) {
        out.status = 'PLC error 0x' + comp.toString(16).toUpperCase().padStart(4, '0');
        out.text = 'completion code ' + comp + ' (GX Works manual me dekho)';
        return out;
    }

    const data = buf.slice(compOff + 2);
    out.ok = true;
    out.status = 'OK';
    const tag = meta.device + meta.address;

    if (meta.mode === 'write') {
        out.text = 'Write OK -> ' + meta.points + (meta.isBit ? ' bit(s)' : ' word(s)') + ' @ ' + tag;
        return out;
    }
    if (meta.isBit) {
        for (let i = 0; i < meta.points; i++) {
            const byte = data[Math.floor(i / 2)] || 0;
            const nib = (i % 2 === 0) ? (byte >> 4) : (byte & 0x0F);
            out.values.push(nib ? 1 : 0);
        }
        out.text = tag + '  [' + meta.points + ' bits] = ' + out.values.join(', ');
    } else {
        for (let i = 0; i < meta.points; i++) {
            if (data.length >= i * 2 + 2) { out.values.push(data.readUInt16LE(i * 2)); }
        }
        out.text = tag + '  [' + meta.points + ' words] = ' + out.values.join(', ');
    }
    return out;
}

// Open a TCP connection, send the request, read a length-correct reply, decode.
// Returns a Promise<result>. Never rejects — errors come back as { ok:false, status }.
function request(opts) {
    return new Promise((resolve) => {
        let built;
        try { built = buildRequest(opts); }
        catch (e) { resolve({ ok: false, status: e.message, text: '', values: [], hex: '' }); return; }

        const host = String(opts.ip || '').trim();
        const port = Number(opts.port) || 5007;
        if (!/^[a-zA-Z0-9_.-]+$/.test(host)) {
            resolve({ ok: false, status: 'invalid PLC IP', text: '', values: [], hex: '' });
            return;
        }

        const sock = new net.Socket();
        let chunks = [];
        let finished = false;
        const finish = (buf, errText) => {
            if (finished) { return; }
            finished = true;
            try { sock.destroy(); } catch (e) {}
            if (errText && (!buf || !buf.length)) {
                resolve({ ok: false, status: errText, text: '', values: [], hex: '' });
            } else {
                resolve(parseResponse(buf, built.meta));
            }
        };

        sock.setTimeout(Number(opts.timeout) || 2500);
        sock.once('error', (e) => finish(Buffer.concat(chunks), 'TCP error: ' + e.message));
        sock.once('timeout', () => finish(Buffer.concat(chunks), 'timeout (no response)'));
        sock.on('data', (d) => {
            chunks.push(d);
            const all = Buffer.concat(chunks);
            const need = expectedLen(all, built.meta.frame);
            if (need > 0 && all.length >= need) { finish(all.slice(0, need), null); }
        });
        sock.on('close', () => { if (!finished) { finish(Buffer.concat(chunks), 'connection closed'); } });
        sock.connect(port, host, () => { sock.write(built.request); });
    });
}

module.exports = { DEV, HEX_ADDR, buildRequest, parseResponse, expectedLen, request };

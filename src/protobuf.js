'use strict';

function varint(n) {
  let v = BigInt(n);
  const out = [];
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint((field << 3) | wire);
}

function ld(field, bytes) {
  const b = Buffer.from(bytes);
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
}

function vf(field, n) {
  return Buffer.concat([tag(field, 0), varint(n)]);
}

function str(field, s) {
  return ld(field, Buffer.from(s, 'utf8'));
}

function bool(field, b) {
  return vf(field, b ? 1 : 0);
}

function readVarint(buf, pos) {
  let x = 0n;
  let s = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    x |= BigInt(b & 0x7f) << s;
    if (!(b & 0x80)) return [x, pos];
    s += 7n;
  }
  throw new Error('truncated varint');
}

function parseProto(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const [key, p] = readVarint(buf, pos);
    pos = p;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos);
      pos = p2;
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      pos = p2;
      const b = buf.subarray(pos, pos + Number(len));
      pos += Number(len);
      out.push({ field, wire, value: b });
    } else if (wire === 1) {
      out.push({ field, wire, value: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wire === 5) {
      out.push({ field, wire, value: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      throw new Error('unsupported wire type ' + wire);
    }
  }
  return out;
}

module.exports = { varint, tag, ld, vf, str, bool, readVarint, parseProto };

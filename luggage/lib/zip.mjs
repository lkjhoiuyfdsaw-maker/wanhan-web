// 极简 zip 读写（零依赖）：只做这一件事 —— 打包/解开 .wanhan-agent 包
// 写：deflate（压不动就 store）；读：按中央目录定位，支持 store / deflate
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31)
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  return { time, date }
}

/** files: [{ name: 'a/b.txt', data: Buffer }] -> Buffer */
export function zipWrite(files) {
  const now = dosTime(new Date())
  const locals = []
  const centrals = []
  let offset = 0

  for (const f of files) {
    const name = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8')
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data)
    const crc = crc32(raw)
    const deflated = zlib.deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(now.time, 10)
    lh.writeUInt16LE(now.date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)

    locals.push(lh, name, body)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(now.time, 12)
    ch.writeUInt16LE(now.date, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(0, 38)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)

    offset += lh.length + name.length + body.length
  }

  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, cd, eocd])
}

/** Buffer -> [{ name, data }] */
export function zipRead(buf) {
  // 从尾部找 EOCD
  let eocd = -1
  const start = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）')

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = []

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const body = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body)

    if (crc32(data) !== crc) throw new Error(`校验失败：${name}`)
    out.push({ name, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

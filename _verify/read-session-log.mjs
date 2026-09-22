/**
 * Read a durable session log (`session.v3.jsonl.zstd`) without the product's
 * own services.
 *
 * WHY this is not a one-liner: the file is not one zstd stream. Every durability
 * flush appends its own independent frame, and Node's `zstdDecompressSync`
 * decodes only the first frame — which, on a real log, is just the 215-byte
 * header line. So the frames are walked explicitly: every occurrence of the
 * zstd frame magic starts a candidate frame, and a candidate that does not
 * decode on its own is extended to the next one (a stray magic inside
 * compressed bytes costs a retry, not a wrong answer).
 *
 * Usage:
 *   node _verify/read-session-log.mjs <path-to-session.v3.jsonl.zstd> [eventType]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Yield the decompressed content of every zstd frame in `buffer`, in order. */
function* frameContents(buffer) {
  let offset = 0
  while (offset < buffer.length) {
    let end = buffer.indexOf(MAGIC, offset + 4)
    for (;;) {
      const slice = buffer.subarray(offset, end === -1 ? buffer.length : end)
      try {
        yield zstdDecompressSync(slice)
        break
      } catch {
        if (end === -1) return
        end = buffer.indexOf(MAGIC, end + 4)
      }
    }
    offset = end === -1 ? buffer.length : end
  }
}

const [target, filter] = process.argv.slice(2)
if (target === undefined) {
  console.error('usage: node _verify/read-session-log.mjs <session.v3.jsonl.zstd> [eventType]')
  process.exit(2)
}

const text = [...frameContents(readFileSync(target))].map((chunk) => chunk.toString('utf8')).join('')
const lines = text.split('\n').filter((line) => line.trim().length > 0)

let matched = 0
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  const type = record.type ?? record.event?.type
  if (filter !== undefined && type !== filter) continue
  const seq = record.seq ?? record.event?.seq
  const data = record.data ?? record.event?.data
  console.log(`seq=${String(seq)} type=${String(type)} ${JSON.stringify(data)}`)
  matched += 1
}

console.error(`frames/lines: ${lines.length}; matched ${filter ?? '*'}: ${matched}`)
